const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { buildApp } = require('../src/app');
const { encrypt } = require('../src/encryption');

const ENCRYPTION_KEY = 'a'.repeat(64);

function createTestApp(fetchFn) {
  return buildApp({
    dbPath: ':memory:',
    sessionSecret: 'test-secret-that-is-at-least-32-characters-long',
    encryptionKey: ENCRYPTION_KEY,
    fetchFn: fetchFn || (() => Promise.resolve({ ok: true, json: () => Promise.resolve({ calendars: { primary: { busy: [] } } }) })),
  });
}

function seedProfile(db, overrides = {}) {
  const defaults = { slug: 'test-profile', name: 'Test Profile', is_active: 1, write_calendar_id: null };
  const { slug, name, is_active, write_calendar_id } = { ...defaults, ...overrides };
  const result = db.prepare(
    "INSERT INTO booking_profiles (slug, name, is_active, write_calendar_id, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(slug, name, is_active, write_calendar_id, '2026-01-01T00:00:00.000Z');
  return result.lastInsertRowid;
}

function seedScheduleTemplate(db, profileId, entries) {
  const stmt = db.prepare("INSERT INTO schedule_templates (profile_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)");
  for (const entry of entries) {
    stmt.run(profileId, entry.day, entry.start, entry.end);
  }
}

function seedCalendarConnection(db, provider = 'google') {
  const result = db.prepare(
    "INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(provider, encrypt('fake-access-token', ENCRYPTION_KEY), encrypt('fake-refresh-token', ENCRYPTION_KEY), '2030-01-01T00:00:00.000Z', 'cal@test.com', 'connected');
  return result.lastInsertRowid;
}

describe('Booking Submission - POST /api/book/:slug', () => {
  let app;
  let calendarEventCreated;
  let lastEventPayload;

  before(async () => {
    calendarEventCreated = false;
    lastEventPayload = null;

    const mockFetch = (url, opts) => {
      if (typeof url === 'string' && url.includes('freeBusy')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ calendars: { primary: { busy: [] } } }),
        });
      }
      if (typeof url === 'string' && url.includes('/calendars/primary/events')) {
        calendarEventCreated = true;
        lastEventPayload = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 'google-event-123' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };

    app = createTestApp(mockFetch);
    await app.ready();
    const hash = await bcrypt.hash('test-pass', 10);
    app.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');
  });

  after(async () => {
    await app.close();
  });

  it('successfully creates a booking and stores record', async () => {
    const connId = seedCalendarConnection(app.db, 'google');
    const profileId = seedProfile(app.db, { slug: 'book-test', write_calendar_id: connId });
    // 2026-07-06 is Monday (day=1)
    seedScheduleTemplate(app.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);

    calendarEventCreated = false;
    lastEventPayload = null;

    const response = await app.inject({
      method: 'POST',
      url: '/api/book/book-test',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'John Doe',
        email: 'john@example.com',
        start_time: '2026-07-06T09:00:00.000Z',
        duration: 30,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 200);
    const data = JSON.parse(response.body);
    assert.ok(data.booking);
    assert.equal(data.booking.title, 'Meeting with John Doe');
    assert.equal(data.booking.start_time, '2026-07-06T09:00:00.000Z');
    assert.equal(data.booking.end_time, '2026-07-06T09:30:00.000Z');
    assert.equal(data.booking.duration_minutes, 30);
    assert.equal(data.booking.booker_name, 'John Doe');
    assert.equal(data.booking.booker_email, 'john@example.com');
    assert.ok(data.booking.cancellation_token);
    assert.equal(data.booking.calendar_event_id, 'google-event-123');
    assert.ok(calendarEventCreated);

    // Verify stored in DB
    const stored = app.db.prepare("SELECT * FROM bookings WHERE profile_id = ?").get(profileId);
    assert.ok(stored);
    assert.equal(stored.status, 'confirmed');
    assert.equal(stored.booker_name, 'John Doe');
    assert.equal(stored.cancellation_token, data.booking.cancellation_token);

    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    app.db.prepare("DELETE FROM calendar_connections WHERE id = ?").run(connId);
  });

  it('includes default attendees and additional attendees in event', async () => {
    const connId = seedCalendarConnection(app.db, 'google');
    const profileId = seedProfile(app.db, { slug: 'attendee-test', write_calendar_id: connId });
    seedScheduleTemplate(app.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);
    app.db.prepare("INSERT INTO default_attendees (profile_id, email) VALUES (?, ?)").run(profileId, 'team@company.com');

    calendarEventCreated = false;
    lastEventPayload = null;

    const response = await app.inject({
      method: 'POST',
      url: '/api/book/attendee-test',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'Jane Smith',
        email: 'jane@example.com',
        additional_attendees: ['colleague@example.com'],
        start_time: '2026-07-06T10:00:00.000Z',
        duration: 45,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(calendarEventCreated);
    // Google event payload should include all attendees
    const attendeeEmails = lastEventPayload.attendees.map(a => a.email);
    assert.ok(attendeeEmails.includes('jane@example.com'));
    assert.ok(attendeeEmails.includes('colleague@example.com'));
    assert.ok(attendeeEmails.includes('team@company.com'));

    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM default_attendees WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    app.db.prepare("DELETE FROM calendar_connections WHERE id = ?").run(connId);
  });

  it('returns error when slot is no longer available (race condition)', async () => {
    const connId = seedCalendarConnection(app.db, 'google');
    const profileId = seedProfile(app.db, { slug: 'race-test', write_calendar_id: connId });
    seedScheduleTemplate(app.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);

    // Pre-book the 09:00 slot
    app.db.prepare(
      "INSERT INTO bookings (profile_id, booker_name, booker_email, title, start_time, end_time, duration_minutes, cancellation_token, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(profileId, 'First Booker', 'first@test.com', 'Meeting', '2026-07-06T09:00:00.000Z', '2026-07-06T09:30:00.000Z', 30, 'cancel-existing', 'confirmed', new Date().toISOString());

    const response = await app.inject({
      method: 'POST',
      url: '/api/book/race-test',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'Second Booker',
        email: 'second@test.com',
        start_time: '2026-07-06T09:00:00.000Z',
        duration: 30,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 409);
    const data = JSON.parse(response.body);
    assert.ok(data.error.includes('no longer available'));

    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    app.db.prepare("DELETE FROM calendar_connections WHERE id = ?").run(connId);
  });

  it('rejects missing name', async () => {
    const profileId = seedProfile(app.db, { slug: 'validate-name' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/book/validate-name',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: 'test@example.com',
        start_time: '2026-07-06T09:00:00.000Z',
        duration: 30,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 400);
    const data = JSON.parse(response.body);
    assert.ok(data.error.includes('name'));

    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
  });

  it('rejects missing email', async () => {
    const profileId = seedProfile(app.db, { slug: 'validate-email' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/book/validate-email',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'Test Person',
        start_time: '2026-07-06T09:00:00.000Z',
        duration: 30,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 400);
    const data = JSON.parse(response.body);
    assert.ok(data.error.includes('email'));

    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
  });

  it('rejects invalid email format', async () => {
    const profileId = seedProfile(app.db, { slug: 'validate-format' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/book/validate-format',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'Test Person',
        email: 'not-an-email',
        start_time: '2026-07-06T09:00:00.000Z',
        duration: 30,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 400);
    const data = JSON.parse(response.body);
    assert.ok(data.error.includes('email'));

    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
  });

  it('returns 404 for non-existent profile', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/book/nonexistent-slug',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'Test',
        email: 'test@example.com',
        start_time: '2026-07-06T09:00:00.000Z',
        duration: 30,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 404);
  });

  it('uses custom title when provided', async () => {
    const connId = seedCalendarConnection(app.db, 'google');
    const profileId = seedProfile(app.db, { slug: 'title-test', write_calendar_id: connId });
    seedScheduleTemplate(app.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/book/title-test',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'John Doe',
        email: 'john@example.com',
        title: 'Project Discussion',
        description: 'Discuss Q3 roadmap',
        start_time: '2026-07-06T11:00:00.000Z',
        duration: 60,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 200);
    const data = JSON.parse(response.body);
    assert.equal(data.booking.title, 'Project Discussion');
    assert.equal(data.booking.description, 'Discuss Q3 roadmap');

    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    app.db.prepare("DELETE FROM calendar_connections WHERE id = ?").run(connId);
  });

  it('includes cancellation link in calendar event description', async () => {
    const connId = seedCalendarConnection(app.db, 'google');
    const profileId = seedProfile(app.db, { slug: 'cancel-link-test', write_calendar_id: connId, meeting_link_url: 'https://meet.google.com/abc' });
    app.db.prepare("UPDATE booking_profiles SET meeting_link_url = ? WHERE id = ?").run('https://meet.google.com/abc', profileId);
    seedScheduleTemplate(app.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);

    lastEventPayload = null;

    const response = await app.inject({
      method: 'POST',
      url: '/api/book/cancel-link-test',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'Cancel Test',
        email: 'cancel@example.com',
        start_time: '2026-07-06T14:00:00.000Z',
        duration: 30,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 200);
    const data = JSON.parse(response.body);
    // The event description should contain the cancellation link
    assert.ok(lastEventPayload.description.includes('/cancel/'));
    assert.ok(lastEventPayload.description.includes(data.booking.cancellation_token));

    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    app.db.prepare("DELETE FROM calendar_connections WHERE id = ?").run(connId);
  });

  it('includes meeting link in response when profile has one', async () => {
    const connId = seedCalendarConnection(app.db, 'google');
    const profileId = seedProfile(app.db, { slug: 'link-test', write_calendar_id: connId });
    app.db.prepare("UPDATE booking_profiles SET meeting_link_url = ? WHERE id = ?").run('https://meet.google.com/xyz', profileId);
    seedScheduleTemplate(app.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/book/link-test',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'Link Test',
        email: 'link@example.com',
        start_time: '2026-07-06T15:00:00.000Z',
        duration: 30,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 200);
    const data = JSON.parse(response.body);
    assert.equal(data.booking.meeting_link, 'https://meet.google.com/xyz');

    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    app.db.prepare("DELETE FROM calendar_connections WHERE id = ?").run(connId);
  });

  it('works with Microsoft calendar provider', async () => {
    let msEventCreated = false;
    const msFetch = (url, opts) => {
      if (typeof url === 'string' && url.includes('freeBusy')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ calendars: { primary: { busy: [] } } }) });
      }
      if (typeof url === 'string' && url.includes('graph.microsoft.com') && url.includes('/events')) {
        msEventCreated = true;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'ms-event-456' }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };

    const msApp = createTestApp(msFetch);
    await msApp.ready();
    const hash = await bcrypt.hash('test-pass', 10);
    msApp.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');

    const connId = seedCalendarConnection(msApp.db, 'microsoft');
    const profileId = seedProfile(msApp.db, { slug: 'ms-test', write_calendar_id: connId });
    seedScheduleTemplate(msApp.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);

    const response = await msApp.inject({
      method: 'POST',
      url: '/api/book/ms-test',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'MS User',
        email: 'ms@example.com',
        start_time: '2026-07-06T09:00:00.000Z',
        duration: 30,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 200);
    const data = JSON.parse(response.body);
    assert.equal(data.booking.calendar_event_id, 'ms-event-456');
    assert.ok(msEventCreated);

    await msApp.close();
  });

  it('works with Zoho calendar provider', async () => {
    let zohoEventCreated = false;
    const zohoFetch = (url, opts) => {
      if (typeof url === 'string' && url.includes('freeBusy')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ fb_data: [] }) });
      }
      if (typeof url === 'string' && url.includes('calendar.zoho.com/api/v1/calendars') && !url.includes('freebusy') && !url.includes('/events')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ calendars: [{ uid: 'cal-uid-1', isprimary: true }] }) });
      }
      if (typeof url === 'string' && url.includes('/events')) {
        zohoEventCreated = true;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ events: [{ uid: 'zoho-event-789' }] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };

    const zohoApp = createTestApp(zohoFetch);
    await zohoApp.ready();
    const hash = await bcrypt.hash('test-pass', 10);
    zohoApp.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');

    const connId = seedCalendarConnection(zohoApp.db, 'zoho');
    const profileId = seedProfile(zohoApp.db, { slug: 'zoho-test', write_calendar_id: connId });
    seedScheduleTemplate(zohoApp.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);

    const response = await zohoApp.inject({
      method: 'POST',
      url: '/api/book/zoho-test',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'Zoho User',
        email: 'zoho@example.com',
        start_time: '2026-07-06T09:00:00.000Z',
        duration: 30,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 200);
    const data = JSON.parse(response.body);
    assert.equal(data.booking.calendar_event_id, 'zoho-event-789');
    assert.ok(zohoEventCreated);

    await zohoApp.close();
  });
});
