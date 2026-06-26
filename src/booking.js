const crypto = require('node:crypto');
const { decrypt } = require('./encryption');

const VALID_DURATIONS = [30, 45, 60];
const LEAD_TIME_MS = 2 * 60 * 60 * 1000;
const HORIZON_MS = 4 * 7 * 24 * 60 * 60 * 1000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
        <section id="form-step" style="display:none">
          <h2>Your Details</h2>
          <div id="booking-error" style="display:none;color:var(--pico-color-red-500)"></div>
          <form id="booking-form">
            <label>Name (required) <input type="text" name="name" required></label>
            <label>Email (required) <input type="email" name="email" required></label>
            <label>Additional Attendees (comma-separated emails) <input type="text" name="additional_attendees"></label>
            <label>Title <input type="text" name="title" placeholder="Meeting with [Your Name]"></label>
            <label>Description <textarea name="description"></textarea></label>
            <button type="submit">Confirm Booking</button>
          </form>
        </section>
        <section id="confirmation-step" style="display:none">
          <h2>Booking Confirmed</h2>
          <div id="confirmation-details"></div>
        </section>
      </div>
      <script>
        (function() {
          const slug = '${escapeHtml(slug)}';
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          let selectedDuration = null;
          let selectedSlotStart = null;

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
            document.getElementById('form-step').style.display = 'none';
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
                  return '<button class="slot-btn outline" data-start="' + s.start + '">' + t + '</button>';
                }).join('');
                container.querySelectorAll('.slot-btn').forEach(function(btn) {
                  btn.addEventListener('click', function() {
                    selectedSlotStart = btn.dataset.start;
                    document.getElementById('form-step').style.display = '';
                    document.getElementById('booking-error').style.display = 'none';
                  });
                });
              });
          }

          function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

          document.getElementById('booking-form').addEventListener('submit', function(e) {
            e.preventDefault();
            var form = e.target;
            var errDiv = document.getElementById('booking-error');
            errDiv.style.display = 'none';

            var attendeesRaw = form.additional_attendees.value.trim();
            var additionalAttendees = attendeesRaw ? attendeesRaw.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];

            var payload = {
              name: form.name.value.trim(),
              email: form.email.value.trim(),
              additional_attendees: additionalAttendees,
              title: form.title.value.trim() || undefined,
              description: form.description.value.trim() || undefined,
              start_time: selectedSlotStart,
              duration: selectedDuration,
              timezone: tz
            };

            fetch('/api/book/' + slug, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            })
            .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
            .then(function(result) {
              if (!result.ok) {
                errDiv.textContent = result.data.error || 'Something went wrong';
                errDiv.style.display = '';
                return;
              }
              var b = result.data.booking;
              document.getElementById('booking-widget').querySelectorAll('section').forEach(function(s) { s.style.display = 'none'; });
              var conf = document.getElementById('confirmation-step');
              conf.style.display = '';
              var startLocal = new Date(b.start_time).toLocaleString(undefined, { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
              var endLocal = new Date(b.end_time).toLocaleTimeString(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit' });
              var details = '<p><strong>' + esc(b.title) + '</strong></p>';
              details += '<p>' + esc(startLocal) + ' - ' + esc(endLocal) + ' (' + b.duration_minutes + ' min)</p>';
              if (b.meeting_link) details += '<p>Meeting link: <a href="' + esc(b.meeting_link) + '">' + esc(b.meeting_link) + '</a></p>';
              details += '<p>Attendees: ' + b.attendees.map(esc).join(', ') + '</p>';
              document.getElementById('confirmation-details').innerHTML = details;
            });
          });
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

async function createCalendarEvent(fetchFn, db, encryptionKey, connection, eventData) {
  let accessToken;
  try {
    accessToken = decrypt(connection.encrypted_access_token, encryptionKey);
  } catch {
    accessToken = connection.encrypted_access_token;
  }

  if (connection.provider === 'google') {
    const event = {
      summary: eventData.title,
      description: eventData.description || '',
      start: { dateTime: eventData.start },
      end: { dateTime: eventData.end },
      attendees: eventData.attendees.map(email => ({ email })),
    };
    const response = await fetchFn('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!response.ok) throw new Error('Google event creation failed');
    const data = await response.json();
    return data.id;
  } else if (connection.provider === 'microsoft') {
    const body = {
      subject: eventData.title,
      start: { dateTime: eventData.start, timeZone: 'UTC' },
      end: { dateTime: eventData.end, timeZone: 'UTC' },
      attendees: eventData.attendees.map(email => ({ emailAddress: { address: email }, type: 'required' })),
      body: { contentType: 'Text', content: eventData.description || '' },
    };
    const response = await fetchFn('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('Microsoft event creation failed');
    const data = await response.json();
    return data.id;
  } else if (connection.provider === 'zoho') {
    const calendarsResponse = await fetchFn('https://calendar.zoho.com/api/v1/calendars', {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    const calendarsData = await calendarsResponse.json();
    const primaryCalendar = calendarsData.calendars.find(c => c.isprimary) || calendarsData.calendars[0];
    const calendarUid = primaryCalendar.uid;

    const pad = n => String(n).padStart(2, '0');
    const formatZoho = (isoStr) => {
      const d = new Date(isoStr);
      return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}+0000`;
    };

    const zohoBody = {
      eventdata: {
        title: eventData.title,
        description: eventData.description || '',
        start: formatZoho(eventData.start),
        end: formatZoho(eventData.end),
        attendees: eventData.attendees.map(email => ({ email })),
      },
    };
    const response = await fetchFn(`https://calendar.zoho.com/api/v1/calendars/${calendarUid}/events`, {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(zohoBody),
    });
    if (!response.ok) throw new Error('Zoho event creation failed');
    const result = await response.json();
    return result.events[0].uid;
  }

  throw new Error(`Unsupported provider: ${connection.provider}`);
}

function registerBookingSubmitApi(app, { encryptionKey }) {
  app.post('/:slug', async (request, reply) => {
    const { slug } = request.params;
    const body = request.body || {};

    const { name, email, additional_attendees, title, description, start_time, duration, timezone } = body;

    if (!name || !name.trim()) {
      return reply.code(400).send({ error: 'name is required' });
    }
    if (!email || !email.trim()) {
      return reply.code(400).send({ error: 'email is required' });
    }
    if (!EMAIL_REGEX.test(email)) {
      return reply.code(400).send({ error: 'invalid email format' });
    }

    if (additional_attendees && Array.isArray(additional_attendees)) {
      for (const attendeeEmail of additional_attendees) {
        if (attendeeEmail && !EMAIL_REGEX.test(attendeeEmail)) {
          return reply.code(400).send({ error: 'invalid additional attendee email format' });
        }
      }
    }

    const durationMinutes = parseInt(duration, 10);
    if (!VALID_DURATIONS.includes(durationMinutes)) {
      return reply.code(400).send({ error: 'duration must be 30, 45, or 60' });
    }

    if (!start_time) {
      return reply.code(400).send({ error: 'start_time is required' });
    }

    const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE slug = ?").get(slug);
    if (!profile) {
      return reply.code(404).send({ error: 'profile not found' });
    }

    if (!profile.is_active) {
      return reply.code(400).send({ error: 'This profile is not currently accepting bookings' });
    }

    const startDate = new Date(start_time);
    const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
    const dateStr = start_time.split('T')[0];

    // Re-validate availability
    const now = new Date();
    let slots = computeSlots(app.db, profile.id, dateStr, durationMinutes, now);

    const existingBookings = getExistingBookings(app.db, profile.id, dateStr);
    if (existingBookings.length > 0) {
      slots = removeConflicts(slots, existingBookings);
    }

    const busySlots = await getCalendarBusySlots(app.db, encryptionKey, profile.id, dateStr, app.fetchFn);
    if (busySlots.length > 0) {
      slots = removeConflicts(slots, busySlots);
    }

    const slotAvailable = slots.some(s => s.start === startDate.toISOString());
    if (!slotAvailable) {
      return reply.code(409).send({ error: 'This slot is no longer available, please pick another' });
    }

    // Gather attendees
    const defaultAttendees = app.db.prepare("SELECT email FROM default_attendees WHERE profile_id = ?").all(profile.id).map(a => a.email);
    const allAttendees = [...new Set([email, ...defaultAttendees, ...(additional_attendees || [])])];

    const bookingTitle = title && title.trim() ? title.trim() : `Meeting with ${name.trim()}`;
    const bookingDescription = description || '';
    const cancellationToken = crypto.randomUUID();

    // Build event description with cancellation link and meeting link
    let eventDescription = bookingDescription;
    if (profile.meeting_link_url) {
      eventDescription += (eventDescription ? '\n\n' : '') + `Meeting link: ${profile.meeting_link_url}`;
    }
    eventDescription += (eventDescription ? '\n\n' : '') + `Cancel this booking: /cancel/${cancellationToken}`;

    // Create calendar event if write calendar is configured
    let calendarEventId = null;
    if (profile.write_calendar_id) {
      const connection = app.db.prepare("SELECT * FROM calendar_connections WHERE id = ? AND status = 'connected'").get(profile.write_calendar_id);
      if (connection) {
        calendarEventId = await createCalendarEvent(app.fetchFn, app.db, encryptionKey, connection, {
          title: bookingTitle,
          description: eventDescription,
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          attendees: allAttendees,
        });
      }
    }

    // Store booking
    app.db.prepare(
      "INSERT INTO bookings (profile_id, booker_name, booker_email, additional_attendees, title, description, start_time, end_time, duration_minutes, cancellation_token, status, calendar_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      profile.id,
      name.trim(),
      email.trim(),
      additional_attendees ? JSON.stringify(additional_attendees) : null,
      bookingTitle,
      bookingDescription,
      startDate.toISOString(),
      endDate.toISOString(),
      durationMinutes,
      cancellationToken,
      'confirmed',
      calendarEventId,
      new Date().toISOString()
    );

    return {
      booking: {
        title: bookingTitle,
        description: bookingDescription || undefined,
        start_time: startDate.toISOString(),
        end_time: endDate.toISOString(),
        duration_minutes: durationMinutes,
        booker_name: name.trim(),
        booker_email: email.trim(),
        additional_attendees: additional_attendees || [],
        cancellation_token: cancellationToken,
        calendar_event_id: calendarEventId,
        meeting_link: profile.meeting_link_url || undefined,
        attendees: allAttendees,
      },
    };
  });
}

async function deleteCalendarEvent(fetchFn, db, encryptionKey, connection, calendarEventId) {
  let accessToken;
  try {
    accessToken = decrypt(connection.encrypted_access_token, encryptionKey);
  } catch {
    accessToken = connection.encrypted_access_token;
  }

  if (connection.provider === 'google') {
    await fetchFn(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${calendarEventId}?sendUpdates=all`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } else if (connection.provider === 'microsoft') {
    await fetchFn(`https://graph.microsoft.com/v1.0/me/events/${calendarEventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } else if (connection.provider === 'zoho') {
    const calendarsResponse = await fetchFn('https://calendar.zoho.com/api/v1/calendars', {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    const calendarsData = await calendarsResponse.json();
    const primaryCalendar = calendarsData.calendars.find(c => c.isprimary) || calendarsData.calendars[0];
    await fetchFn(`https://calendar.zoho.com/api/v1/calendars/${primaryCalendar.uid}/events/${calendarEventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
  }
}

function registerCancellationPage(app, { encryptionKey, baseLayout }) {
  app.get('/:token', async (request, reply) => {
    const { token } = request.params;
    const booking = app.db.prepare("SELECT b.*, bp.name as profile_name FROM bookings b JOIN booking_profiles bp ON b.profile_id = bp.id WHERE b.cancellation_token = ?").get(token);

    if (!booking) {
      return reply.code(404).type('text/html').send(baseLayout('Not Found', '<h1>Booking not found</h1>'));
    }

    if (booking.status === 'cancelled') {
      return reply.type('text/html').send(baseLayout('Already Cancelled', `
        <h1>Booking Already Cancelled</h1>
        <p>This booking has already been cancelled.</p>
      `));
    }

    const startDate = new Date(booking.start_time);
    const endDate = new Date(booking.end_time);
    const dateStr = startDate.toISOString().split('T')[0];
    const startTime = startDate.toISOString().split('T')[1].slice(0, 5);
    const endTime = endDate.toISOString().split('T')[1].slice(0, 5);
    const attendees = [booking.booker_email];
    if (booking.additional_attendees) {
      try { attendees.push(...JSON.parse(booking.additional_attendees)); } catch {}
    }

    reply.type('text/html').send(baseLayout('Cancel Booking', `
      <h1>Cancel Booking</h1>
      <p>Are you sure you want to cancel this booking?</p>
      <article>
        <header><strong>${escapeHtml(booking.title)}</strong></header>
        <p>Date: ${escapeHtml(dateStr)}</p>
        <p>Time: ${escapeHtml(startTime)} - ${escapeHtml(endTime)} UTC</p>
        <p>Attendees: ${attendees.map(e => escapeHtml(e)).join(', ')}</p>
      </article>
      <form method="POST" action="/api/cancel/${escapeHtml(token)}">
        <button type="submit" class="contrast">Confirm Cancellation</button>
      </form>
      <a href="/" role="button" class="outline">Keep Booking</a>
    `));
  });
}

function registerCancellationApi(app, { encryptionKey }) {
  app.post('/:token', async (request, reply) => {
    const { token } = request.params;
    const booking = app.db.prepare("SELECT b.*, bp.write_calendar_id FROM bookings b JOIN booking_profiles bp ON b.profile_id = bp.id WHERE b.cancellation_token = ?").get(token);

    if (!booking) {
      return reply.code(404).send({ error: 'Booking not found' });
    }

    if (booking.status === 'cancelled') {
      return reply.code(400).send({ error: 'This booking has already been cancelled' });
    }

    // Attempt to delete calendar event
    if (booking.calendar_event_id && booking.write_calendar_id) {
      const connection = app.db.prepare("SELECT * FROM calendar_connections WHERE id = ? AND status = 'connected'").get(booking.write_calendar_id);
      if (connection) {
        try {
          await deleteCalendarEvent(app.fetchFn, app.db, encryptionKey, connection, booking.calendar_event_id);
        } catch {
          // If calendar API fails, still proceed with local cancellation
        }
      }
    }

    // Mark as cancelled in DB
    app.db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);

    return { message: 'Booking successfully cancelled' };
  });
}

module.exports = { registerBookingRoutes, registerSlotsApi, registerBookingSubmitApi, registerCancellationPage, registerCancellationApi, computeSlots, removeConflicts, getCalendarBusySlots, getExistingBookings, VALID_DURATIONS };
