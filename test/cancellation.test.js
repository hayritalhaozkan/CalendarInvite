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
    fetchFn: fetchFn || (() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
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

function seedCalendarConnection(db, provider = 'google') {
  const result = db.prepare(
    "INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(provider, encrypt('fake-access-token', ENCRYPTION_KEY), encrypt('fake-refresh-token', ENCRYPTION_KEY), '2030-01-01T00:00:00.000Z', 'cal@test.com', 'connected');
  return result.lastInsertRowid;
}

function seedBooking(db, profileId, overrides = {}) {
  const defaults = {
    booker_name: 'John Doe',
    booker_email: 'john@example.com',
    additional_attendees: null,
    title: 'Test Meeting',
    description: 'A test meeting',
    start_time: '2026-07-06T09:00:00.000Z',
    end_time: '2026-07-06T09:30:00.000Z',
    duration_minutes: 30,
    cancellation_token: 'test-cancel-token-123',
    status: 'confirmed',
    calendar_event_id: 'google-event-abc',
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const data = { ...defaults, ...overrides };
  const result = db.prepare(
    "INSERT INTO bookings (profile_id, booker_name, booker_email, additional_attendees, title, description, start_time, end_time, duration_minutes, cancellation_token, status, calendar_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    profileId, data.booker_name, data.booker_email, data.additional_attendees,
    data.title, data.description, data.start_time, data.end_time,
    data.duration_minutes, data.cancellation_token, data.status,
    data.calendar_event_id, data.created_at
  );
  return result.lastInsertRowid;
}

describe('Booking Cancellation - GET /cancel/:token', () => {
  let app;

  before(async () => {
    app = createTestApp();
    await app.ready();
    const hash = await bcrypt.hash('test-pass', 10);
    app.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');
  });

  after(async () => {
    await app.close();
  });

  it('renders cancellation confirmation page with booking details', async () => {
    const profileId = seedProfile(app.db, { slug: 'cancel-page' });
    seedBooking(app.db, profileId, {
      cancellation_token: 'valid-token-1',
      title: 'Project Review',
      booker_name: 'Jane Smith',
      booker_email: 'jane@example.com',
      additional_attendees: JSON.stringify(['bob@example.com']),
      start_time: '2026-07-06T14:00:00.000Z',
      end_time: '2026-07-06T14:30:00.000Z',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/cancel/valid-token-1',
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Project Review'));
    assert.ok(response.body.includes('jane@example.com'));
    assert.ok(response.body.includes('bob@example.com'));
    assert.ok(response.body.includes('2026-07-06'));

    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
  });

  it('returns 404 for invalid token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/cancel/nonexistent-token',
    });

    assert.equal(response.statusCode, 404);
    assert.ok(response.body.includes('Booking not found'));
  });

  it('shows already-cancelled message for cancelled booking', async () => {
    const profileId = seedProfile(app.db, { slug: 'cancel-already' });
    seedBooking(app.db, profileId, {
      cancellation_token: 'already-cancelled-token',
      status: 'cancelled',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/cancel/already-cancelled-token',
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('already been cancelled'));

    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
  });
});

describe('Booking Cancellation - POST /api/cancel/:token', () => {
  let app;
  let deleteEventCalled;
  let lastDeleteUrl;

  before(async () => {
    deleteEventCalled = false;
    lastDeleteUrl = null;

    const mockFetch = (url, opts) => {
      if (opts && opts.method === 'DELETE') {
        deleteEventCalled = true;
        lastDeleteUrl = url;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
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

  it('cancels a booking and calls calendar delete API', async () => {
    const connId = seedCalendarConnection(app.db, 'google');
    const profileId = seedProfile(app.db, { slug: 'cancel-api', write_calendar_id: connId });
    seedBooking(app.db, profileId, {
      cancellation_token: 'cancel-me-token',
      calendar_event_id: 'google-event-to-delete',
    });

    deleteEventCalled = false;
    lastDeleteUrl = null;

    const response = await app.inject({
      method: 'POST',
      url: '/api/cancel/cancel-me-token',
    });

    assert.equal(response.statusCode, 200);
    const data = JSON.parse(response.body);
    assert.ok(data.message.includes('cancelled'));

    // Verify DB updated
    const booking = app.db.prepare("SELECT * FROM bookings WHERE cancellation_token = ?").get('cancel-me-token');
    assert.equal(booking.status, 'cancelled');

    // Verify calendar API called
    assert.ok(deleteEventCalled);
    assert.ok(lastDeleteUrl.includes('google-event-to-delete'));

    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    app.db.prepare("DELETE FROM calendar_connections WHERE id = ?").run(connId);
  });

  it('returns 404 for invalid token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/cancel/nonexistent-token',
    });

    assert.equal(response.statusCode, 404);
    const data = JSON.parse(response.body);
    assert.ok(data.error.includes('not found'));
  });

  it('returns appropriate message for already-cancelled booking', async () => {
    const profileId = seedProfile(app.db, { slug: 'cancel-twice' });
    seedBooking(app.db, profileId, {
      cancellation_token: 'already-done-token',
      status: 'cancelled',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/cancel/already-done-token',
    });

    assert.equal(response.statusCode, 400);
    const data = JSON.parse(response.body);
    assert.ok(data.error.includes('already'));

    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
  });

  it('still marks as cancelled when calendar API delete fails', async () => {
    const failFetch = (url, opts) => {
      if (opts && opts.method === 'DELETE') {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'Not found' }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };

    const failApp = createTestApp(failFetch);
    await failApp.ready();
    const hash = await bcrypt.hash('test-pass', 10);
    failApp.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');

    const connId = seedCalendarConnection(failApp.db, 'google');
    const profileId = seedProfile(failApp.db, { slug: 'cancel-fail', write_calendar_id: connId });
    seedBooking(failApp.db, profileId, {
      cancellation_token: 'fail-delete-token',
      calendar_event_id: 'event-already-gone',
    });

    const response = await failApp.inject({
      method: 'POST',
      url: '/api/cancel/fail-delete-token',
    });

    assert.equal(response.statusCode, 200);
    const data = JSON.parse(response.body);
    assert.ok(data.message.includes('cancelled'));

    // Still marked as cancelled in DB
    const booking = failApp.db.prepare("SELECT * FROM bookings WHERE cancellation_token = ?").get('fail-delete-token');
    assert.equal(booking.status, 'cancelled');

    await failApp.close();
  });

  it('cancelled bookings no longer block availability', async () => {
    const freeBusyFetch = (url) => {
      if (typeof url === 'string' && url.includes('freeBusy')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ calendars: { primary: { busy: [] } } }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };

    const slotApp = createTestApp(freeBusyFetch);
    await slotApp.ready();
    const hash = await bcrypt.hash('test-pass', 10);
    slotApp.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');

    const profileId = seedProfile(slotApp.db, { slug: 'avail-test' });
    // Monday 2026-07-06
    slotApp.db.prepare("INSERT INTO schedule_templates (profile_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)").run(profileId, 1, '09:00', '17:00');

    // Add a cancelled booking at 09:00
    seedBooking(slotApp.db, profileId, {
      cancellation_token: 'cancelled-booking-token',
      status: 'cancelled',
      start_time: '2026-07-06T09:00:00.000Z',
      end_time: '2026-07-06T09:30:00.000Z',
    });

    const response = await slotApp.inject({
      method: 'GET',
      url: '/api/book/avail-test/slots?date=2026-07-06&duration=30&timezone=UTC',
    });

    assert.equal(response.statusCode, 200);
    const data = JSON.parse(response.body);
    // The 09:00 slot should be available since the booking is cancelled
    const nineAmSlot = data.slots.find(s => s.start === '2026-07-06T09:00:00.000Z');
    assert.ok(nineAmSlot, '09:00 slot should be available after cancellation');

    await slotApp.close();
  });
});
