const { decrypt } = require('./encryption');

const VALID_DURATIONS = [30, 45, 60];
const LEAD_TIME_MS = 2 * 60 * 60 * 1000;
const HORIZON_MS = 4 * 7 * 24 * 60 * 60 * 1000;

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function computeSlots(db, profileId, dateStr, durationMinutes, now) {
  const date = new Date(dateStr + 'T00:00:00.000Z');
  const dayOfWeek = date.getUTCDay();

  const override = db.prepare(
    "SELECT * FROM schedule_overrides WHERE profile_id = ? AND date = ?"
  ).get(profileId, dateStr);

  let ranges;
  if (override) {
    if (override.is_blocked) return [];
    if (override.custom_ranges) {
      ranges = JSON.parse(override.custom_ranges);
    } else {
      ranges = [];
    }
  } else {
    const templates = db.prepare(
      "SELECT start_time, end_time FROM schedule_templates WHERE profile_id = ? AND day_of_week = ? ORDER BY start_time"
    ).all(profileId, dayOfWeek);
    ranges = templates.map(t => ({ start: t.start_time, end: t.end_time }));
  }

  if (ranges.length === 0) return [];

  const slots = [];
  const durationMs = durationMinutes * 60 * 1000;
  const leadTimeCutoff = new Date(now.getTime() + LEAD_TIME_MS);
  const horizonCutoff = new Date(now.getTime() + HORIZON_MS);

  for (const range of ranges) {
    const [startH, startM] = range.start.split(':').map(Number);
    const [endH, endM] = range.end.split(':').map(Number);

    const rangeStart = new Date(date);
    rangeStart.setUTCHours(startH, startM, 0, 0);
    const rangeEnd = new Date(date);
    rangeEnd.setUTCHours(endH, endM, 0, 0);

    let slotStart = rangeStart.getTime();
    while (slotStart + durationMs <= rangeEnd.getTime()) {
      const slotStartDate = new Date(slotStart);
      const slotEndDate = new Date(slotStart + durationMs);

      if (slotStartDate >= leadTimeCutoff && slotStartDate < horizonCutoff) {
        slots.push({
          start: slotStartDate.toISOString(),
          end: slotEndDate.toISOString(),
        });
      }
      slotStart += 30 * 60 * 1000;
    }
  }

  return slots;
}

function removeConflicts(slots, busyPeriods) {
  return slots.filter(slot => {
    const slotStart = new Date(slot.start).getTime();
    const slotEnd = new Date(slot.end).getTime();
    for (const busy of busyPeriods) {
      const busyStart = new Date(busy.start).getTime();
      const busyEnd = new Date(busy.end).getTime();
      if (slotStart < busyEnd && slotEnd > busyStart) {
        return false;
      }
    }
    return true;
  });
}

async function getCalendarBusySlots(db, encryptionKey, profileId, dateStr, fetchFn) {
  const readCalendars = db.prepare(
    "SELECT cc.* FROM profile_read_calendars prc JOIN calendar_connections cc ON prc.calendar_connection_id = cc.id WHERE prc.profile_id = ? AND cc.status = 'connected'"
  ).all(profileId);

  if (readCalendars.length === 0) return [];

  const timeMin = dateStr + 'T00:00:00Z';
  const timeMax = dateStr + 'T23:59:59Z';
  const allBusy = [];

  for (const cal of readCalendars) {
    try {
      let accessToken;
      try {
        accessToken = decrypt(cal.encrypted_access_token, encryptionKey);
      } catch {
        accessToken = cal.encrypted_access_token;
      }

      if (cal.provider === 'google') {
        const response = await fetchFn('https://www.googleapis.com/calendar/v3/freeBusy', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            timeMin,
            timeMax,
            items: [{ id: 'primary' }],
          }),
        });
        if (response.ok) {
          const data = await response.json();
          const busy = data.calendars?.primary?.busy || [];
          allBusy.push(...busy);
        }
      } else if (cal.provider === 'microsoft') {
        const response = await fetchFn('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            schedules: [cal.email],
            startTime: { dateTime: timeMin, timeZone: 'UTC' },
            endTime: { dateTime: timeMax, timeZone: 'UTC' },
          }),
        });
        if (response.ok) {
          const data = await response.json();
          const scheduleItems = data.value?.[0]?.scheduleItems || [];
          allBusy.push(...scheduleItems.map(item => ({
            start: item.start.dateTime,
            end: item.end.dateTime,
          })));
        }
      } else if (cal.provider === 'zoho') {
        const params = new URLSearchParams({ stime: timeMin, etime: timeMax });
        const response = await fetchFn(
          `https://calendar.zoho.com/api/v1/calendars/freebusy?${params}`,
          { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
        );
        if (response.ok) {
          const data = await response.json();
          const fbData = data.fb_data || [];
          allBusy.push(...fbData.filter(s => s.fbtype === 'busy').map(s => ({
            start: s.s_datetime,
            end: s.e_datetime,
          })));
        }
      }
    } catch {
      // Skip calendar errors gracefully
    }
  }

  return allBusy;
}

function getExistingBookings(db, profileId, dateStr) {
  const dayStart = dateStr + 'T00:00:00.000Z';
  const dayEnd = dateStr + 'T23:59:59.999Z';
  return db.prepare(
    "SELECT start_time as start, end_time as end FROM bookings WHERE profile_id = ? AND status = 'confirmed' AND start_time >= ? AND end_time <= ?"
  ).all(profileId, dayStart, dayEnd);
}

function registerBookingRoutes(app, { encryptionKey, baseLayout }) {
  app.get('/:slug', async (request, reply) => {
    const { slug } = request.params;
    const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE slug = ?").get(slug);

    if (!profile) {
      return reply.code(404).type('text/html').send(baseLayout('Not Found', '<h1>Page not found</h1>'));
    }

    if (!profile.is_active) {
      return reply.type('text/html').send(baseLayout(`Book - ${escapeHtml(profile.name)}`, `
        <h1>${escapeHtml(profile.name)}</h1>
        <p>Not currently accepting bookings</p>
      `));
    }

    reply.type('text/html').send(baseLayout(`Book - ${escapeHtml(profile.name)}`, `
      <h1>${escapeHtml(profile.name)}</h1>
      <div id="booking-widget">
        <section id="duration-step">
          <h2>Select Duration</h2>
          <div role="group">
            <button class="duration-btn" data-duration="30">30 min</button>
            <button class="duration-btn" data-duration="45">45 min</button>
            <button class="duration-btn" data-duration="60">60 min</button>
          </div>
        </section>
        <section id="calendar-step" style="display:none">
          <h2>Select a Date</h2>
          <div id="calendar-grid"></div>
        </section>
        <section id="slots-step" style="display:none">
          <h2>Available Times</h2>
          <div id="time-slots"></div>
        </section>
      </div>
      <script>
        (function() {
          const slug = '${escapeHtml(slug)}';
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          let selectedDuration = null;

          document.querySelectorAll('.duration-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
              selectedDuration = parseInt(btn.dataset.duration);
              document.getElementById('calendar-step').style.display = '';
              renderCalendar();
            });
          });

          function renderCalendar() {
            var now = new Date();
            var grid = document.getElementById('calendar-grid');
            grid.innerHTML = '';
            var horizon = new Date(now.getTime() + 4 * 7 * 24 * 60 * 60 * 1000);
            var d = new Date(now);
            d.setHours(0,0,0,0);
            while (d < horizon) {
              var dateStr = d.toISOString().split('T')[0];
              var btn = document.createElement('button');
              btn.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
              btn.className = 'outline';
              (function(ds) {
                btn.addEventListener('click', function() { loadSlots(ds); });
              })(dateStr);
              grid.appendChild(btn);
              d.setDate(d.getDate() + 1);
            }
          }

          function loadSlots(dateStr) {
            document.getElementById('slots-step').style.display = '';
            var container = document.getElementById('time-slots');
            container.innerHTML = '<p>Loading...</p>';
            fetch('/api/book/' + slug + '/slots?date=' + dateStr + '&duration=' + selectedDuration + '&timezone=' + tz)
              .then(function(res) { return res.json(); })
              .then(function(data) {
                if (!data.slots.length) {
                  container.innerHTML = '<p>No available times for this date.</p>';
                  return;
                }
                container.innerHTML = data.slots.map(function(s) {
                  var t = new Date(s.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: tz });
                  return '<button class="slot-btn outline">' + t + '</button>';
                }).join('');
              });
          }
        })();
      </script>
    `));
  });
}

function registerSlotsApi(app, { encryptionKey }) {
  app.get('/:slug/slots', async (request, reply) => {
    const { slug } = request.params;
    const { date, duration, timezone } = request.query;

    if (!date || !duration) {
      return reply.code(400).send({ error: 'date and duration are required' });
    }

    const durationMinutes = parseInt(duration, 10);
    if (!VALID_DURATIONS.includes(durationMinutes)) {
      return reply.code(400).send({ error: 'duration must be 30, 45, or 60' });
    }

    const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE slug = ?").get(slug);
    if (!profile) {
      return reply.code(404).send({ error: 'profile not found' });
    }

    const now = new Date();
    let slots = computeSlots(app.db, profile.id, date, durationMinutes, now);

    const existingBookings = getExistingBookings(app.db, profile.id, date);
    if (existingBookings.length > 0) {
      slots = removeConflicts(slots, existingBookings);
    }

    const busySlots = await getCalendarBusySlots(app.db, encryptionKey, profile.id, date, app.fetchFn);
    if (busySlots.length > 0) {
      slots = removeConflicts(slots, busySlots);
    }

    return { slots };
  });
}

module.exports = { registerBookingRoutes, registerSlotsApi, computeSlots, removeConflicts, getCalendarBusySlots, getExistingBookings, VALID_DURATIONS };
