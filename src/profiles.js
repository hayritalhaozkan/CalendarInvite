const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseScheduleFromBody(body) {
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
        entries.push({ day_of_week: day, start_time: startArr[i], end_time: endArr[i] });
      }
    }
  }
  return entries;
}

function parseAttendeesFromBody(body) {
  const raw = body['attendees[]'];
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter(e => e && e.trim()).map(e => e.trim());
}

function profileFormHtml(token, profile, calendars, attendees, schedules, error) {
  const isEdit = !!profile;
  const action = isEdit ? `/admin/profiles/${profile.id}` : '/admin/profiles';
  const title = isEdit ? 'Edit Profile' : 'New Profile';

  const calendarOptions = calendars.map(c =>
    `<option value="${c.id}">${escapeHtml(c.email)} (${c.provider})</option>`
  ).join('');

  const writeCalendarOptions = `<option value="">-- None --</option>` + calendars.map(c =>
    `<option value="${c.id}" ${profile && profile.write_calendar_id === c.id ? 'selected' : ''}>${escapeHtml(c.email)} (${c.provider})</option>`
  ).join('');

  const readCalendarIds = isEdit
    ? schedules.readCalendarIds || []
    : [];

  const readCalendarCheckboxes = calendars.map(c =>
    `<label><input type="checkbox" name="read_calendar_ids[]" value="${c.id}" ${readCalendarIds.includes(c.id) ? 'checked' : ''}> ${escapeHtml(c.email)} (${c.provider})</label>`
  ).join('');

  const attendeeInputs = attendees.length > 0
    ? attendees.map(e => `<input type="text" name="attendees[]" value="${escapeHtml(e)}">`).join('')
    : '<input type="text" name="attendees[]" value="">';

  const scheduleHtml = DAYS.map((dayName, dayIdx) => {
    const daySchedules = (schedules.templates || []).filter(s => s.day_of_week === dayIdx);
    const ranges = daySchedules.length > 0
      ? daySchedules.map(s => `<div><input type="time" name="schedule[${dayIdx}][start][]" value="${s.start_time}"> - <input type="time" name="schedule[${dayIdx}][end][]" value="${s.end_time}"></div>`).join('')
      : `<div><input type="time" name="schedule[${dayIdx}][start][]" value=""> - <input type="time" name="schedule[${dayIdx}][end][]" value=""></div>`;
    return `<fieldset><legend>${dayName}</legend>${ranges}</fieldset>`;
  }).join('');

  return `
    <h1>${title}</h1>
    ${error ? `<p style="color: var(--pico-color-red-500);">${escapeHtml(error)}</p>` : ''}
    <form method="POST" action="${action}">
      <input type="hidden" name="_csrf" value="${token}">
      <label>Slug <input type="text" name="slug" value="${escapeHtml(profile?.slug || '')}" required></label>
      <label>Name <input type="text" name="name" value="${escapeHtml(profile?.name || '')}" required></label>
      <label>Meeting Link URL <input type="url" name="meeting_link_url" value="${escapeHtml(profile?.meeting_link_url || '')}"></label>
      <label>Meeting Tool
        <select name="meeting_tool">
          <option value="">-- None --</option>
          <option value="meet" ${profile?.meeting_tool === 'meet' ? 'selected' : ''}>Google Meet</option>
          <option value="teams" ${profile?.meeting_tool === 'teams' ? 'selected' : ''}>Microsoft Teams</option>
        </select>
      </label>
      <label>Write Calendar
        <select name="write_calendar_id">${writeCalendarOptions}</select>
      </label>
      <fieldset>
        <legend>Read Calendars</legend>
        ${readCalendarCheckboxes || '<p>No calendar connections available.</p>'}
      </fieldset>
      <fieldset>
        <legend>Default Attendees</legend>
        ${attendeeInputs}
      </fieldset>
      <fieldset>
        <legend>Schedule Template</legend>
        ${scheduleHtml}
      </fieldset>
      <button type="submit">${isEdit ? 'Update' : 'Create'} Profile</button>
    </form>
    <a href="/admin/profiles">&larr; Back to profiles</a>
  `;
}

function registerProfileRoutes(app) {
  app.get('/profiles', async (request, reply) => {
    const profiles = app.db.prepare("SELECT * FROM booking_profiles ORDER BY created_at DESC").all();
    const rows = profiles.map(p => `
      <tr>
        <td>${escapeHtml(p.slug)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${p.is_active ? 'Active' : 'Inactive'}</td>
        <td><a href="/admin/profiles/${p.id}/edit">Edit</a></td>
      </tr>
    `).join('');

    const html = `
      <h1>Booking Profiles</h1>
      <a href="/admin/profiles/new" role="button">New Profile</a>
      <table>
        <thead><tr><th>Slug</th><th>Name</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    reply.type('text/html').send(require('./app').BASE_LAYOUT('Profiles', html));
  });

  app.get('/profiles/new', async (request, reply) => {
    const token = reply.generateCsrf();
    const calendars = app.db.prepare("SELECT * FROM calendar_connections WHERE status = 'connected'").all();
    const html = profileFormHtml(token, null, calendars, [], { templates: [], readCalendarIds: [] }, null);
    reply.type('text/html').send(require('./app').BASE_LAYOUT('New Profile', html));
  });

  app.post('/profiles', { preHandler: app.csrfProtection }, async (request, reply) => {
    const { slug, name, meeting_link_url, meeting_tool, write_calendar_id } = request.body || {};

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

    const result = app.db.prepare(
      "INSERT INTO booking_profiles (slug, name, is_active, write_calendar_id, meeting_link_url, meeting_tool, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)"
    ).run(slug, name, write_calendar_id || null, meeting_link_url || null, meeting_tool || null, new Date().toISOString());

    const profileId = result.lastInsertRowid;

    const attendees = parseAttendeesFromBody(request.body);
    const insertAttendee = app.db.prepare("INSERT INTO default_attendees (profile_id, email) VALUES (?, ?)");
    for (const email of attendees) {
      insertAttendee.run(profileId, email);
    }

    const scheduleEntries = parseScheduleFromBody(request.body);
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

    const html = profileFormHtml(token, profile, calendars, attendees, { templates, readCalendarIds }, null);
    reply.type('text/html').send(require('./app').BASE_LAYOUT('Edit Profile', html));
  });

  app.post('/profiles/:id', { preHandler: app.csrfProtection }, async (request, reply) => {
    const { id } = request.params;
    const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE id = ?").get(id);
    if (!profile) {
      return reply.code(404).type('text/html').send(require('./app').BASE_LAYOUT('Not Found', '<h1>Profile not found</h1>'));
    }

    const { slug, name, meeting_link_url, meeting_tool, write_calendar_id } = request.body || {};

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
      "UPDATE booking_profiles SET slug = ?, name = ?, write_calendar_id = ?, meeting_link_url = ?, meeting_tool = ? WHERE id = ?"
    ).run(slug, name, write_calendar_id || null, meeting_link_url || null, meeting_tool || null, id);

    // Replace attendees
    app.db.prepare("DELETE FROM default_attendees WHERE profile_id = ?").run(id);
    const attendees = parseAttendeesFromBody(request.body);
    const insertAttendee = app.db.prepare("INSERT INTO default_attendees (profile_id, email) VALUES (?, ?)");
    for (const email of attendees) {
      insertAttendee.run(id, email);
    }

    // Replace schedule templates
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(id);
    const scheduleEntries = parseScheduleFromBody(request.body);
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

    return reply.redirect('/admin/profiles');
  });

  app.post('/profiles/:id/delete', { preHandler: app.csrfProtection }, async (request, reply) => {
    const { id } = request.params;
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(id);
    return reply.redirect('/admin/profiles');
  });

  app.post('/profiles/:id/toggle', { preHandler: app.csrfProtection }, async (request, reply) => {
    const { id } = request.params;
    app.db.prepare("UPDATE booking_profiles SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?").run(id);
    return reply.redirect('/admin/profiles');
  });
}

module.exports = { registerProfileRoutes };
