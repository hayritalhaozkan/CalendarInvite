const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function convertUTCToLocalTime(utcTimeStr, adminTimezone) {
  if (!utcTimeStr || utcTimeStr.length === 0) return utcTimeStr;

  const [hours, minutes] = utcTimeStr.split(':').map(Number);

  // Create UTC date
  const now = new Date();
  const utcDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0));

  // Convert to local time
  const localHours = String(utcDate.getHours()).padStart(2, '0');
  const localMinutes = String(utcDate.getMinutes()).padStart(2, '0');

  return `${localHours}:${localMinutes}`;
}

function convertTimeToUTC(timeStr, adminTimezone) {
  if (!timeStr || timeStr.length === 0) return timeStr;

  const [hours, minutes] = timeStr.split(':').map(Number);

  // Create a date in admin's timezone
  const now = new Date();
  const localDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);

  // Get UTC time string
  const utcHours = String(localDate.getUTCHours()).padStart(2, '0');
  const utcMinutes = String(localDate.getUTCMinutes()).padStart(2, '0');

  return `${utcHours}:${utcMinutes}`;
}

function parseScheduleFromBody(body, adminTimezone = 'UTC') {
  const entries = [];
  for (let day = 0; day <= 6; day++) {
    const key = `schedule[${day}]`;
    const starts = body[`${key}[start][]`];
    const ends = body[`${key}[end][]`];
    if (!starts || !ends) continue;

    const startArr = Array.isArray(starts) ? starts : [starts];
    const endArr = Array.isArray(ends) ? ends : [ends];

    for (let i = 0; i < startArr.length; i++) {
      if (startArr[i] && endArr[i]) {
        const utcStart = convertTimeToUTC(startArr[i], adminTimezone);
        const utcEnd = convertTimeToUTC(endArr[i], adminTimezone);
        entries.push({ day_of_week: day, start_time: utcStart, end_time: utcEnd });
      }
    }
  }
  return entries;
}

function parseAttendeesFromBody(body) {
  const raw = body['attendees[]'];
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .flatMap(e => e.split(','))
    .filter(e => e && e.trim())
    .map(e => e.trim());
}

function parseOverridesFromBody(body) {
  const dates = body['override_dates[]'];
  const isBlockeds = body['override_is_blocked[]'];
  const customRanges = body['override_custom_ranges[]'];
  const overrides = [];
  if (dates) {
    const dArr = Array.isArray(dates) ? dates : [dates];
    const bArr = Array.isArray(isBlockeds) ? isBlockeds : [isBlockeds];
    const cArr = Array.isArray(customRanges) ? customRanges : [customRanges];
    for (let i = 0; i < dArr.length; i++) {
      overrides.push({
        date: dArr[i],
        is_blocked: parseInt(bArr[i], 10) || 0,
        custom_ranges: cArr[i] && cArr[i].trim() !== '' ? cArr[i] : null
      });
    }
  }
  return overrides;
}

function overridesHtml(overrides) {
  const overrideRows = (overrides || []).map(o => {
    const isBlocked = o.is_blocked ? 1 : 0;
    const typeLabel = isBlocked ? 'Blocked' : 'Custom';
    let rangesDisplay = '';
    if (!isBlocked && o.custom_ranges) {
      const ranges = JSON.parse(o.custom_ranges);
      rangesDisplay = ranges.map(r => `${escapeHtml(r.start)} - ${escapeHtml(r.end)}`).join(', ');
    }

    return `<tr>
      <td>
        ${escapeHtml(o.date)}
        <input type="hidden" name="override_dates[]" value="${escapeHtml(o.date)}">
        <input type="hidden" name="override_is_blocked[]" value="${isBlocked}">
        <input type="hidden" name="override_custom_ranges[]" value="${escapeHtml(o.custom_ranges || '')}">
      </td>
      <td>${typeLabel}</td>
      <td>${rangesDisplay}</td>
      <td><button type="button" class="danger outline remove-override-btn" style="padding: 4px 8px; font-size: 12px;">Delete</button></td>
    </tr>`;
  }).join('');

  return `
    <fieldset>
      <legend>Schedule Overrides</legend>
      <small style="color: var(--text-secondary); display: block; margin-bottom: 1rem;">Add specific dates where you are unavailable or have custom hours.</small>
      
      <table id="overrides-table" style="${overrides && overrides.length ? '' : 'display:none;'}">
        <thead><tr><th>Date</th><th>Type</th><th>Hours</th><th>Actions</th></tr></thead>
        <tbody id="overrides-tbody">${overrideRows}</tbody>
      </table>
      <p id="no-overrides-msg" style="${overrides && overrides.length ? 'display:none;' : ''}">No overrides configured.</p>

      <div style="margin-top: 1rem; border: 1px solid var(--border-color); padding: 1rem; border-radius: 8px;">
        <h4 style="margin-top: 0; margin-bottom: 1rem;">Add New Override</h4>
        <div style="display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-end;">
          <div style="display: flex; flex-direction: column; margin-bottom: 0;">
            <label for="new_override_date" style="margin-bottom: 0.25rem; font-size: 0.875rem;">Date</label>
            <input type="date" id="new_override_date" style="margin-bottom: 0;">
          </div>
          <div style="display: flex; flex-direction: column; margin-bottom: 0;">
            <label for="new_override_type" style="margin-bottom: 0.25rem; font-size: 0.875rem;">Type</label>
            <select id="new_override_type" style="margin-bottom: 0;">
              <option value="blocked">Block entire day</option>
              <option value="custom">Custom hours</option>
            </select>
          </div>
          <div id="new_override_custom" style="display:none; gap: 0.5rem; align-items: center; margin-bottom: 0;">
            <input type="text" class="time-picker-override" id="new_override_start" value="09:00" style="width: 100px; margin-bottom: 0;">
            <span style="margin-bottom: 0;">-</span>
            <input type="text" class="time-picker-override" id="new_override_end" value="17:00" style="width: 100px; margin-bottom: 0;">
          </div>
          <button type="button" id="add-override-btn" class="outline" style="margin-bottom: 0; padding-top: 0.5rem; padding-bottom: 0.5rem;">Add Override</button>
        </div>
      </div>
    </fieldset>
  `;
}

function profileFormHtml(token, profile, calendars, attendees, schedules, error, overrides, adminTimezone = 'UTC') {
  const isEdit = !!profile;
  const action = isEdit ? `/admin/profiles/${profile.id}` : '/admin/profiles';
  const title = isEdit ? 'Edit Profile' : 'New Profile';

  const calendarOptions = calendars.map(c =>
    `<option value="${c.id}">${escapeHtml(c.email)} (${c.provider})</option>`
  ).join('');

  const writeCalendarIds = isEdit
    ? (schedules.writeCalendarIds || []).concat(profile.write_calendar_id ? [profile.write_calendar_id] : [])
    : [];

  const writeCalendarCheckboxes = calendars.map(c =>
    `<label><input type="checkbox" name="write_calendar_ids[]" value="${c.id}" ${writeCalendarIds.includes(c.id) ? 'checked' : ''}> ${escapeHtml(c.email)} (${c.provider})</label>`
  ).join('');

  const readCalendarIds = isEdit
    ? schedules.readCalendarIds || []
    : [];

  const readCalendarCheckboxes = calendars.map(c =>
    `<label><input type="checkbox" name="read_calendar_ids[]" value="${c.id}" ${readCalendarIds.includes(c.id) ? 'checked' : ''}> ${escapeHtml(c.email)} (${c.provider})</label>`
  ).join('');

  const attendeeValue = attendees.length > 0 ? escapeHtml(attendees.join(', ')) : '';
  const attendeeInputs = `<input type="text" name="attendees[]" value="${attendeeValue}" placeholder="colleague@example.com, other@example.com">`;

  const scheduleHtml = `<div class="schedule-grid">` + DAYS.map((dayName, dayIdx) => {
    const daySchedules = (schedules.templates || []).filter(s => s.day_of_week === dayIdx);
    const isActive = daySchedules.length > 0;
    
    let rangesHtml = '';
    if (isActive) {
      rangesHtml = daySchedules.map(s => {
        const localStart = convertUTCToLocalTime(s.start_time, adminTimezone);
        const localEnd = convertUTCToLocalTime(s.end_time, adminTimezone);
        return `<div class="time-range"><input type="text" class="time-picker" name="schedule[${dayIdx}][start][]" value="${localStart}" required style="width: 120px; padding: 0.5rem; margin-bottom: 0;"> <span>-</span> <input type="text" class="time-picker" name="schedule[${dayIdx}][end][]" value="${localEnd}" required style="width: 120px; padding: 0.5rem; margin-bottom: 0;"><button type="button" class="danger outline remove-range" style="padding:4px 8px; border:none;" title="Remove">✕</button></div>`;
      }).join('');
    } else {
      rangesHtml = `<div class="time-range"><input type="text" class="time-picker" name="schedule[${dayIdx}][start][]" value="09:00" disabled required style="width: 120px; padding: 0.5rem; margin-bottom: 0;"> <span>-</span> <input type="text" class="time-picker" name="schedule[${dayIdx}][end][]" value="17:00" disabled required style="width: 120px; padding: 0.5rem; margin-bottom: 0;"><button type="button" class="danger outline remove-range" style="padding:4px 8px; border:none;" title="Remove">✕</button></div>`;
    }

    return `
      <div class="schedule-day ${isActive ? '' : 'disabled'}" id="day-row-${dayIdx}">
        <div class="day-toggle">
          <input type="checkbox" class="toggle-day-cb" data-day="${dayIdx}" id="toggle-${dayIdx}" ${isActive ? 'checked' : ''}>
          <label for="toggle-${dayIdx}">${dayName}</label>
        </div>
        <div class="time-ranges" id="ranges-${dayIdx}" style="${isActive ? '' : 'display:none;'}">
          <div class="ranges-container" id="container-${dayIdx}">${rangesHtml}</div>
          <div style="margin-top: 8px; display: flex; gap: 8px;">
            <button type="button" class="outline add-range-btn" data-day="${dayIdx}" style="padding: 4px 8px; font-size: 12px;">+ Add Hours</button>
            <button type="button" class="outline copy-btn" data-day="${dayIdx}" style="padding: 4px 8px; font-size: 12px;">Copy to All</button>
          </div>
        </div>
        <div class="unavailable-text" id="unavail-${dayIdx}" style="${isActive ? 'display:none;' : 'margin-top:4px; font-size: 14px; color: var(--text-secondary);'}">
          Unavailable
        </div>
      </div>
    `;
  }).join('') + `</div>`;

  const overrideSection = overridesHtml(overrides || []);

  return `
    <nav>
      <a href="/admin/dashboard">Dashboard</a>
      <a href="/admin/bookings">Bookings</a>
      <a href="/admin/profiles">Profiles</a>
      <a href="/admin/calendars">Calendars</a>
      <a href="/admin/settings">Settings</a>
    </nav>
    <h1>${title}</h1>
    ${error ? `<div role="alert" class="error">${escapeHtml(error)}</div>` : ''}
    <div class="card">
      <form method="POST" action="${action}">
        <input type="hidden" name="_csrf" value="${token}">

        <fieldset>
          <legend>Profile Settings</legend>
          <label>
            Slug
            <input type="text" name="slug" value="${escapeHtml(profile?.slug || '')}" placeholder="my-booking-page" required>
            <small style="color: var(--text-secondary);">URL-friendly identifier (e.g., my-meeting). Will be used in /book/slug</small>
          </label>

          <label>
            Display Name
            <input type="text" name="name" value="${escapeHtml(profile?.name || '')}" placeholder="30 Min Meeting" required>
          </label>
        </fieldset>

        <fieldset>
          <legend>Meeting Configuration</legend>
          <label>
            Meeting Link URL
            <input type="url" name="meeting_link_url" value="${escapeHtml(profile?.meeting_link_url || '')}" placeholder="https://meet.google.com/abc-defg-hij">
            <small style="color: var(--text-secondary);">Static meeting room URL (optional)</small>
          </label>

          <label>
            Meeting Tool
            <select name="meeting_tool">
              <option value="">-- None --</option>
              <option value="meet" ${profile?.meeting_tool === 'meet' ? 'selected' : ''}>Google Meet</option>
              <option value="teams" ${profile?.meeting_tool === 'teams' ? 'selected' : ''}>Microsoft Teams</option>
            </select>
          </label>

          <div style="margin-top: 0.5rem;">
            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;">Buffer Time Between Meetings</div>
            <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 8px; background: var(--neutral-10); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 16px;">
                <input
                  type="number"
                  id="buffer_time_minutes"
                  name="buffer_time_minutes"
                  value="${profile?.buffer_time_minutes ?? 0}"
                  min="0" max="120" step="5"
                  style="width: 64px; font-size: 22px; font-weight: 700; text-align: center; border: none; background: transparent; color: var(--primary); margin: 0; padding: 0; -moz-appearance: textfield;"
                >
                <span style="font-size: 13px; color: var(--text-secondary); line-height: 1.3;">min<br>buffer</span>
              </div>
              <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                ${[0, 5, 10, 15, 30].map(v => `
                  <button type="button"
                    onclick="document.getElementById('buffer_time_minutes').value=${v}"
                    style="padding: 6px 14px; font-size: 13px; font-weight: 600; border-radius: 20px; border: 1.5px solid var(--border-color); background: ${(profile?.buffer_time_minutes ?? 0) == v ? 'var(--primary)' : 'var(--neutral-0)'}; color: ${(profile?.buffer_time_minutes ?? 0) == v ? '#fff' : 'var(--text-secondary)'}; cursor: pointer; transition: all 0.15s;">
                    ${v === 0 ? 'None' : v + ' min'}
                  </button>`).join('')}
              </div>
            </div>
            <p style="margin-top: 8px; font-size: 12px; color: var(--text-secondary); margin-bottom: 0;">
              Adds a gap before and after each booking. A 15 min buffer means no new booking can start within 15 min of an existing one.
            </p>
          </div>
        </fieldset>

        <fieldset>
          <legend>Calendar Integration</legend>
          <label style="display: block; font-weight: 600;">Write Calendars</label>
          <small style="color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">Calendars where bookings will be created</small>
          <div style="display: flex; flex-direction: column; gap: 0.5rem;">
            ${writeCalendarCheckboxes || '<p style="color: var(--text-secondary);">No calendar connections available.</p>'}
          </div>

          <label style="margin-top: 1rem; display: block; font-weight: 600;">Read Calendars (for availability)</label>
          <div style="display: flex; flex-direction: column; gap: 0.5rem;">
            ${readCalendarCheckboxes || '<p style="color: var(--text-secondary);">No calendar connections available. <a href="/admin/calendars">Connect a calendar</a></p>'}
          </div>
        </fieldset>

        <fieldset>
          <legend>Default Attendees</legend>
          <small style="color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">Email addresses to include in every booking (separate multiple emails with commas)</small>
          ${attendeeInputs}
        </fieldset>

        <fieldset>
          <legend>Weekly Schedule</legend>
          <small style="color: var(--text-secondary); display: block; margin-bottom: 1rem;">Set your recurring availability for each day of the week</small>
          ${scheduleHtml}
        </fieldset>

        ${overrideSection}
        <div style="display: flex; gap: 1rem; align-items: center;">
          <button type="submit">${isEdit ? 'Update' : 'Create'} Profile</button>
          <a href="/admin/profiles" role="button" class="secondary">Cancel</a>
          ${isEdit ? `
          <button type="submit" form="delete-profile-form" class="danger outline" style="margin-left: auto;">Delete Profile</button>
          ` : ''}
        </div>
      </form>

      ${isEdit ? `
      <form id="delete-profile-form" method="POST" action="/admin/profiles/${profile.id}/delete" style="display:none;" onsubmit="return confirm('Are you sure you want to delete this profile? All bookings and settings associated with it will be permanently deleted.');">
        <input type="hidden" name="_csrf" value="${token}">
      </form>
      ` : ''}
    </div>
    <script>
      document.addEventListener('DOMContentLoaded', () => {
        flatpickr('.time-picker-override', { enableTime: true, noCalendar: true, dateFormat: "H:i", time_24hr: true });

        document.getElementById('new_override_type').addEventListener('change', (e) => {
          document.getElementById('new_override_custom').style.display = e.target.value === 'custom' ? 'flex' : 'none';
        });

        document.getElementById('overrides-tbody').addEventListener('click', (e) => {
          if (e.target.classList.contains('remove-override-btn')) {
            e.target.closest('tr').remove();
            if (document.querySelectorAll('#overrides-tbody tr').length === 0) {
              document.getElementById('overrides-table').style.display = 'none';
              document.getElementById('no-overrides-msg').style.display = 'block';
            }
          }
        });

        document.getElementById('add-override-btn').addEventListener('click', () => {
          const date = document.getElementById('new_override_date').value;
          const type = document.getElementById('new_override_type').value;
          if (!date) return alert('Please select a date.');
          
          const isBlocked = type === 'blocked';
          let customRangesStr = '';
          let rangesDisplay = '';
          
          if (!isBlocked) {
            const start = document.getElementById('new_override_start').value;
            const end = document.getElementById('new_override_end').value;
            if (!start || !end) return alert('Please select start and end times.');
            const ranges = [{ start, end }];
            customRangesStr = JSON.stringify(ranges);
            rangesDisplay = start + ' - ' + end;
          }

          const tbody = document.getElementById('overrides-tbody');
          const tr = document.createElement('tr');
          const typeLabel = isBlocked ? 'Blocked' : 'Custom';
          const escapeHtml = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          
          tr.innerHTML = 
            '<td>' +
              escapeHtml(date) +
              '<input type="hidden" name="override_dates[]" value="' + escapeHtml(date) + '">' +
              '<input type="hidden" name="override_is_blocked[]" value="' + (isBlocked ? '1' : '0') + '">' +
              '<input type="hidden" name="override_custom_ranges[]" value="' + escapeHtml(customRangesStr) + '">' +
            '</td>' +
            '<td>' + typeLabel + '</td>' +
            '<td>' + rangesDisplay + '</td>' +
            '<td><button type="button" class="danger outline remove-override-btn" style="padding: 4px 8px; font-size: 12px;">Delete</button></td>';
          tbody.appendChild(tr);
          
          document.getElementById('overrides-table').style.display = '';
          document.getElementById('no-overrides-msg').style.display = 'none';
          document.getElementById('new_override_date').value = '';
        });
        // Toggle Day
        document.querySelectorAll('.toggle-day-cb').forEach(cb => {
          cb.addEventListener('change', (e) => {
            const day = e.target.dataset.day;
            const row = document.getElementById('day-row-' + day);
            const rangesDiv = document.getElementById('ranges-' + day);
            const unavailText = document.getElementById('unavail-' + day);
            
            if (e.target.checked) {
              row.classList.remove('disabled');
              rangesDiv.style.display = 'block';
              unavailText.style.display = 'none';
              rangesDiv.querySelectorAll('input').forEach(inp => {
                inp.disabled = false;
              });
            } else {
              row.classList.add('disabled');
              rangesDiv.style.display = 'none';
              unavailText.style.display = 'block';
              rangesDiv.querySelectorAll('input').forEach(inp => {
                inp.disabled = true;
              });
            }
          });
        });

        // Remove Range
        document.addEventListener('click', (e) => {
          if (e.target.classList.contains('remove-range')) {
            const timeRange = e.target.closest('.time-range');
            const container = timeRange.parentElement;
            timeRange.remove();
            
            if (container.children.length === 0) {
              const day = container.id.replace('container-', '');
              const cb = document.getElementById('toggle-' + day);
              if (cb) {
                cb.checked = false;
                cb.dispatchEvent(new Event('change'));
                container.innerHTML = \`<div class="time-range"><input type="text" class="time-picker" name="schedule[\${day}][start][]" value="09:00" disabled required style="width: 120px; padding: 0.5rem; margin-bottom: 0;"> <span>-</span> <input type="text" class="time-picker" name="schedule[\${day}][end][]" value="17:00" disabled required style="width: 120px; padding: 0.5rem; margin-bottom: 0;"><button type="button" class="danger outline remove-range" style="padding:4px 8px; border:none;" title="Remove">✕</button></div>\`;
                if(window.initTimePickers) window.initTimePickers();
              }
            }
          }
        });

        // Add Range
        document.querySelectorAll('.add-range-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const day = e.target.dataset.day;
            const container = document.getElementById('container-' + day);
            const div = document.createElement('div');
            div.className = 'time-range';
            div.innerHTML = \`<input type="text" class="time-picker" name="schedule[\${day}][start][]" value="09:00" required style="width: 120px; padding: 0.5rem; margin-bottom: 0;"> <span>-</span> <input type="text" class="time-picker" name="schedule[\${day}][end][]" value="17:00" required style="width: 120px; padding: 0.5rem; margin-bottom: 0;"><button type="button" class="danger outline remove-range" style="padding:4px 8px; border:none;" title="Remove">✕</button>\`;
            container.appendChild(div);
            if(window.initTimePickers) window.initTimePickers();
          });
        });

        // Copy to All
        document.querySelectorAll('.copy-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const sourceDay = e.target.dataset.day;
            const sourceContainer = document.getElementById('container-' + sourceDay);
            const sourceInputs = Array.from(sourceContainer.querySelectorAll('.time-range')).map(tr => {
              const start = tr.querySelector('input[name*="[start]"]').value;
              const end = tr.querySelector('input[name*="[end]"]').value;
              return {start, end};
            });

            for (let i = 0; i <= 6; i++) {
              if (i == sourceDay) continue; 
              const cb = document.getElementById('toggle-' + i);
              cb.checked = true;
              cb.dispatchEvent(new Event('change'));
              
              const container = document.getElementById('container-' + i);
              container.innerHTML = sourceInputs.map(val => 
                \`<div class="time-range"><input type="text" class="time-picker" name="schedule[\${i}][start][]" value="\${val.start}" required style="width: 120px; padding: 0.5rem; margin-bottom: 0;"> <span>-</span> <input type="text" class="time-picker" name="schedule[\${i}][end][]" value="\${val.end}" required style="width: 120px; padding: 0.5rem; margin-bottom: 0;"><button type="button" class="danger outline remove-range" style="padding:4px 8px; border:none;" title="Remove">✕</button></div>\`
              ).join('');
            }
            if(window.initTimePickers) window.initTimePickers();
            
            const originalText = e.target.textContent;
            e.target.textContent = 'Copied!';
            setTimeout(() => { e.target.textContent = originalText; }, 2000);
          });
        });
      });
    </script>
  `;
}

function registerProfileRoutes(app) {
  app.get('/profiles', async (request, reply) => {
    const profiles = app.db.prepare("SELECT * FROM booking_profiles ORDER BY created_at DESC").all();
    const baseUrl = `${request.protocol}://${request.hostname}${request.port && request.port !== 80 && request.port !== 443 ? ':' + request.port : ''}`;

    const rows = profiles.map(p => {
      const bookingUrl = `${baseUrl}/book/${escapeHtml(p.slug)}`;
      return `
      <tr>
        <td><code>${escapeHtml(p.slug)}</code></td>
        <td>${escapeHtml(p.name)}</td>
        <td><span class="badge ${p.is_active ? 'success' : 'error'}">${p.is_active ? 'Active' : 'Inactive'}</span></td>
        <td class="booking-link-cell">
          <div class="booking-link-container">
            <a href="${bookingUrl}" target="_blank" class="booking-link" title="Open booking page in new tab">${bookingUrl}</a>
            <button class="copy-link-btn outline" data-url="${bookingUrl}">Copy</button>
          </div>
        </td>
        <td>
          <a href="/admin/profiles/${p.id}/edit" role="button" class="outline" style="padding: 4px 12px; margin: 0;">Edit</a>
        </td>
      </tr>
    `}).join('');

    const html = `
      <nav>
        <a href="/admin/dashboard">Dashboard</a>
        <a href="/admin/bookings">Bookings</a>
        <a href="/admin/profiles">Profiles</a>
        <a href="/admin/calendars">Calendars</a>
        <a href="/admin/settings">Settings</a>
      </nav>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
        <h1 style="margin-bottom: 0;">Booking Profiles</h1>
        <a href="/admin/profiles/new" role="button">+ New Profile</a>
      </div>
      ${profiles.length ? `
        <table>
          <thead><tr><th>Slug</th><th>Name</th><th>Status</th><th>Booking Link</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <script>
          document.querySelectorAll('.copy-link-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
              var url = btn.dataset.url;
              navigator.clipboard.writeText(url).then(function() {
                var originalText = btn.textContent;
                btn.textContent = 'Copied!';
                btn.style.background = 'var(--success)';
                btn.style.color = 'var(--neutral-0)';
                btn.style.borderColor = 'var(--success)';
                setTimeout(function() {
                  btn.textContent = originalText;
                  btn.style.background = '';
                  btn.style.color = '';
                  btn.style.borderColor = '';
                }, 2000);
              }).catch(function() {
                btn.textContent = 'Failed';
                setTimeout(function() {
                  btn.textContent = 'Copy';
                }, 2000);
              });
            });
          });
        </script>
      ` : '<article><p>No profiles yet. Create your first booking profile to get started.</p><a href="/admin/profiles/new" role="button">Create Profile</a></article>'}
    `;
    reply.type('text/html').send(require('./app').BASE_LAYOUT('Profiles', html));
  });

  app.get('/profiles/new', async (request, reply) => {
    const token = reply.generateCsrf();
    const calendars = app.db.prepare("SELECT * FROM calendar_connections WHERE status = 'connected'").all();
    const adminTimezone = process.env.ADMIN_TIMEZONE || 'UTC';
    const html = profileFormHtml(token, null, calendars, [], { templates: [], readCalendarIds: [] }, null, [], adminTimezone);
    reply.type('text/html').send(require('./app').BASE_LAYOUT('New Profile', html));
  });

  app.post('/profiles', { preHandler: app.csrfProtection }, async (request, reply) => {
    const { slug, name, meeting_link_url, meeting_tool } = request.body || {};

    if (!slug || !SLUG_REGEX.test(slug)) {
      const token = reply.generateCsrf();
      const calendars = app.db.prepare("SELECT * FROM calendar_connections WHERE status = 'connected'").all();
      const html = profileFormHtml(token, null, calendars, [], { templates: [], readCalendarIds: [] }, 'Slug must be lowercase alphanumeric and hyphens only.');
      return reply.type('text/html').send(require('./app').BASE_LAYOUT('New Profile', html));
    }

    const existing = app.db.prepare("SELECT id FROM booking_profiles WHERE slug = ?").get(slug);
    if (existing) {
      const token = reply.generateCsrf();
      const calendars = app.db.prepare("SELECT * FROM calendar_connections WHERE status = 'connected'").all();
      const html = profileFormHtml(token, null, calendars, [], { templates: [], readCalendarIds: [] }, 'That slug already exists. Please choose a different one.');
      return reply.type('text/html').send(require('./app').BASE_LAYOUT('New Profile', html));
    }

    const buffer_time_minutes = parseInt(request.body.buffer_time_minutes, 10) || 0;

    const result = app.db.prepare(
      "INSERT INTO booking_profiles (slug, name, is_active, write_calendar_id, meeting_link_url, meeting_tool, buffer_time_minutes, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)"
    ).run(slug, name, null, meeting_link_url || null, meeting_tool || null, buffer_time_minutes, new Date().toISOString());

    const profileId = result.lastInsertRowid;

    const attendees = parseAttendeesFromBody(request.body);
    const insertAttendee = app.db.prepare("INSERT INTO default_attendees (profile_id, email) VALUES (?, ?)");
    for (const email of attendees) {
      insertAttendee.run(profileId, email);
    }

    const adminTimezone = process.env.ADMIN_TIMEZONE || 'UTC';
    const scheduleEntries = parseScheduleFromBody(request.body, adminTimezone);
    const insertSchedule = app.db.prepare("INSERT INTO schedule_templates (profile_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)");
    for (const entry of scheduleEntries) {
      insertSchedule.run(profileId, entry.day_of_week, entry.start_time, entry.end_time);
    }

    const readCalIds = request.body['read_calendar_ids[]'];
    if (readCalIds) {
      const ids = Array.isArray(readCalIds) ? readCalIds : [readCalIds];
      const insertRead = app.db.prepare("INSERT INTO profile_read_calendars (profile_id, calendar_connection_id) VALUES (?, ?)");
      for (const cid of ids) {
        insertRead.run(profileId, Number(cid));
      }
    }

    const writeCalIds = request.body['write_calendar_ids[]'];
    if (writeCalIds) {
      const wIds = Array.isArray(writeCalIds) ? writeCalIds : [writeCalIds];
      const insertWrite = app.db.prepare("INSERT INTO profile_write_calendars (profile_id, calendar_connection_id) VALUES (?, ?)");
      for (const cid of wIds) {
        insertWrite.run(profileId, Number(cid));
      }
    }

    const overrides = parseOverridesFromBody(request.body);
    const insertOverride = app.db.prepare("INSERT INTO schedule_overrides (profile_id, date, is_blocked, custom_ranges) VALUES (?, ?, ?, ?)");
    for (const o of overrides) {
      insertOverride.run(profileId, o.date, o.is_blocked, o.custom_ranges);
    }

    return reply.redirect('/admin/profiles');
  });

  app.get('/profiles/:id/edit', async (request, reply) => {
    const { id } = request.params;
    const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE id = ?").get(id);
    if (!profile) {
      return reply.code(404).type('text/html').send(require('./app').BASE_LAYOUT('Not Found', '<h1>Profile not found</h1>'));
    }

    const token = reply.generateCsrf();
    const calendars = app.db.prepare("SELECT * FROM calendar_connections WHERE status = 'connected'").all();
    const attendees = app.db.prepare("SELECT email FROM default_attendees WHERE profile_id = ?").all(profile.id).map(a => a.email);
    const templates = app.db.prepare("SELECT * FROM schedule_templates WHERE profile_id = ? ORDER BY day_of_week, start_time").all(profile.id);
    const readCalendarIds = app.db.prepare("SELECT calendar_connection_id FROM profile_read_calendars WHERE profile_id = ?").all(profile.id).map(r => r.calendar_connection_id);
    const writeCalendarIds = app.db.prepare("SELECT calendar_connection_id FROM profile_write_calendars WHERE profile_id = ?").all(profile.id).map(r => r.calendar_connection_id);
    const overrides = app.db.prepare("SELECT * FROM schedule_overrides WHERE profile_id = ? ORDER BY date").all(profile.id);
    const adminTimezone = process.env.ADMIN_TIMEZONE || 'UTC';

    const html = profileFormHtml(token, profile, calendars, attendees, { templates, readCalendarIds, writeCalendarIds }, null, overrides, adminTimezone);
    reply.type('text/html').send(require('./app').BASE_LAYOUT('Edit Profile', html));
  });

  app.post('/profiles/:id', { preHandler: app.csrfProtection }, async (request, reply) => {
    const { id } = request.params;
    const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE id = ?").get(id);
    if (!profile) {
      return reply.code(404).type('text/html').send(require('./app').BASE_LAYOUT('Not Found', '<h1>Profile not found</h1>'));
    }

    const { slug, name, meeting_link_url, meeting_tool } = request.body || {};
    const buffer_time_minutes = parseInt(request.body.buffer_time_minutes, 10) || 0;

    if (!slug || !SLUG_REGEX.test(slug)) {
      const token = reply.generateCsrf();
      const calendars = app.db.prepare("SELECT * FROM calendar_connections WHERE status = 'connected'").all();
      const attendees = app.db.prepare("SELECT email FROM default_attendees WHERE profile_id = ?").all(profile.id).map(a => a.email);
      const templates = app.db.prepare("SELECT * FROM schedule_templates WHERE profile_id = ?").all(profile.id);
      const html = profileFormHtml(token, profile, calendars, attendees, { templates, readCalendarIds: [] }, 'Slug must be lowercase alphanumeric and hyphens only.');
      return reply.type('text/html').send(require('./app').BASE_LAYOUT('Edit Profile', html));
    }

    const existing = app.db.prepare("SELECT id FROM booking_profiles WHERE slug = ? AND id != ?").get(slug, id);
    if (existing) {
      const token = reply.generateCsrf();
      const calendars = app.db.prepare("SELECT * FROM calendar_connections WHERE status = 'connected'").all();
      const attendees = app.db.prepare("SELECT email FROM default_attendees WHERE profile_id = ?").all(profile.id).map(a => a.email);
      const templates = app.db.prepare("SELECT * FROM schedule_templates WHERE profile_id = ?").all(profile.id);
      const html = profileFormHtml(token, profile, calendars, attendees, { templates, readCalendarIds: [] }, 'That slug already exists.');
      return reply.type('text/html').send(require('./app').BASE_LAYOUT('Edit Profile', html));
    }

    app.db.prepare(
      "UPDATE booking_profiles SET slug = ?, name = ?, write_calendar_id = ?, meeting_link_url = ?, meeting_tool = ?, buffer_time_minutes = ? WHERE id = ?"
    ).run(slug, name, null, meeting_link_url || null, meeting_tool || null, buffer_time_minutes, id);

    // Replace attendees
    app.db.prepare("DELETE FROM default_attendees WHERE profile_id = ?").run(id);
    const attendees = parseAttendeesFromBody(request.body);
    const insertAttendee = app.db.prepare("INSERT INTO default_attendees (profile_id, email) VALUES (?, ?)");
    for (const email of attendees) {
      insertAttendee.run(id, email);
    }

    // Replace schedule templates
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(id);
    const adminTimezone = process.env.ADMIN_TIMEZONE || 'UTC';
    const scheduleEntries = parseScheduleFromBody(request.body, adminTimezone);
    const insertSchedule = app.db.prepare("INSERT INTO schedule_templates (profile_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)");
    for (const entry of scheduleEntries) {
      insertSchedule.run(id, entry.day_of_week, entry.start_time, entry.end_time);
    }

    // Replace read calendars
    app.db.prepare("DELETE FROM profile_read_calendars WHERE profile_id = ?").run(id);
    const readCalIds = request.body['read_calendar_ids[]'];
    if (readCalIds) {
      const ids = Array.isArray(readCalIds) ? readCalIds : [readCalIds];
      const insertRead = app.db.prepare("INSERT INTO profile_read_calendars (profile_id, calendar_connection_id) VALUES (?, ?)");
      for (const cid of ids) {
        insertRead.run(id, Number(cid));
      }
    }

    // Replace write calendars
    app.db.prepare("DELETE FROM profile_write_calendars WHERE profile_id = ?").run(id);
    const writeCalIds = request.body['write_calendar_ids[]'];
    if (writeCalIds) {
      const wIds = Array.isArray(writeCalIds) ? writeCalIds : [writeCalIds];
      const insertWrite = app.db.prepare("INSERT INTO profile_write_calendars (profile_id, calendar_connection_id) VALUES (?, ?)");
      for (const cid of wIds) {
        insertWrite.run(id, Number(cid));
      }
    }

    app.db.prepare("DELETE FROM schedule_overrides WHERE profile_id = ?").run(id);
    const overrides = parseOverridesFromBody(request.body);
    const insertOverride = app.db.prepare("INSERT INTO schedule_overrides (profile_id, date, is_blocked, custom_ranges) VALUES (?, ?, ?, ?)");
    for (const o of overrides) {
      insertOverride.run(id, o.date, o.is_blocked, o.custom_ranges);
    }

    return reply.redirect('/admin/profiles');
  });



  app.post('/profiles/:id/toggle', { preHandler: app.csrfProtection }, async (request, reply) => {
    const { id } = request.params;
    app.db.prepare("UPDATE booking_profiles SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?").run(id);
    return reply.redirect('/admin/profiles');
  });

  app.post('/profiles/:id/delete', { preHandler: app.csrfProtection }, async (request, reply) => {
    const { id } = request.params;
    const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE id = ?").get(id);
    if (!profile) {
      return reply.code(404).type('text/html').send(require('./app').BASE_LAYOUT('Not Found', '<h1>Profile not found</h1>'));
    }
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(id);
    return reply.redirect('/admin/profiles');
  });
}

module.exports = { registerProfileRoutes };
