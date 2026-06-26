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

async function login(app) {
  const loginPage = await app.inject({ method: 'GET', url: '/admin/login' });
  const csrfToken = loginPage.body.match(/name="_csrf" value="([^"]+)"/)[1];
  const cookies = loginPage.headers['set-cookie'];

  const loginResponse = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
    payload: { username: 'admin', password: 'test-pass', _csrf: csrfToken },
  });

  return loginResponse.headers['set-cookie'];
}

async function getCsrfAndCookies(app, url, sessionCookies) {
  const page = await app.inject({
    method: 'GET',
    url,
    headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
  });
  const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)[1];
  const cookies = page.headers['set-cookie'] || sessionCookies;
  return { csrf, cookies, body: page.body, statusCode: page.statusCode };
}

function seedBooking(db, profileId, overrides = {}) {
  const defaults = {
    booker_name: 'Test Booker',
    booker_email: 'booker@test.com',
    title: 'Test Meeting',
    start_time: '2026-07-10T10:00:00.000Z',
    end_time: '2026-07-10T10:30:00.000Z',
    duration_minutes: 30,
    status: 'confirmed',
    calendar_event_id: null,
  };
  const d = { ...defaults, ...overrides };
  const token = `cancel-${Math.random().toString(36).slice(2)}`;
  const result = db.prepare(
    "INSERT INTO bookings (profile_id, booker_name, booker_email, additional_attendees, title, description, start_time, end_time, duration_minutes, cancellation_token, status, calendar_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(profileId, d.booker_name, d.booker_email, null, d.title, null, d.start_time, d.end_time, d.duration_minutes, token, d.status, d.calendar_event_id, '2026-06-01T00:00:00.000Z');
  return result.lastInsertRowid;
}

describe('Admin Dashboard - GET /admin/dashboard', () => {
  let app, sessionCookies;

  before(async () => {
    app = createTestApp();
    await app.ready();
    const hash = await bcrypt.hash('test-pass', 10);
    app.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'America/New_York');
    sessionCookies = await login(app);
  });

  after(async () => {
    await app.close();
  });

  it('shows number of active profiles', async () => {
    app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('active-1', 'Active One', 1, '2026-01-01T00:00:00Z');
    app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('inactive-1', 'Inactive One', 0, '2026-01-01T00:00:00Z');

    const response = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('1'), 'Should show count of active profiles');
    assert.ok(response.body.includes('Active Profiles'));

    app.db.prepare("DELETE FROM booking_profiles").run();
  });

  it('shows number of upcoming bookings', async () => {
    const profileId = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('dash-profile', 'Dash Profile', 1, '2026-01-01T00:00:00Z').lastInsertRowid;

    seedBooking(app.db, profileId, { start_time: '2099-07-10T10:00:00.000Z', end_time: '2099-07-10T10:30:00.000Z', status: 'confirmed' });
    seedBooking(app.db, profileId, { start_time: '2099-07-11T10:00:00.000Z', end_time: '2099-07-11T10:30:00.000Z', status: 'confirmed' });
    seedBooking(app.db, profileId, { start_time: '2099-07-12T10:00:00.000Z', end_time: '2099-07-12T10:30:00.000Z', status: 'cancelled' });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Upcoming Bookings'));
    // Should show 2 upcoming confirmed bookings
    assert.ok(response.body.includes('2'));

    app.db.prepare("DELETE FROM bookings").run();
    app.db.prepare("DELETE FROM booking_profiles").run();
  });

  it('shows next 5 upcoming bookings with date/time/title/booker name', async () => {
    const profileId = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('dash-next5', 'Dash Next5', 1, '2026-01-01T00:00:00Z').lastInsertRowid;

    for (let i = 1; i <= 7; i++) {
      seedBooking(app.db, profileId, {
        booker_name: `Booker ${i}`,
        title: `Meeting ${i}`,
        start_time: `2099-08-${String(i).padStart(2, '0')}T10:00:00.000Z`,
        end_time: `2099-08-${String(i).padStart(2, '0')}T10:30:00.000Z`,
      });
    }

    const response = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
    });

    assert.equal(response.statusCode, 200);
    // Should show first 5 bookers, not booker 6 or 7
    assert.ok(response.body.includes('Booker 1'));
    assert.ok(response.body.includes('Booker 5'));
    assert.ok(!response.body.includes('Booker 6'));
    assert.ok(response.body.includes('Meeting 1'));

    app.db.prepare("DELETE FROM bookings").run();
    app.db.prepare("DELETE FROM booking_profiles").run();
  });
});

describe('Admin Bookings List - GET /admin/bookings', () => {
  let app, sessionCookies;

  before(async () => {
    app = createTestApp();
    await app.ready();
    const hash = await bcrypt.hash('test-pass', 10);
    app.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');
    sessionCookies = await login(app);
  });

  after(async () => {
    await app.close();
  });

  it('shows paginated list of all bookings (upcoming first, then past)', async () => {
    const profileId = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('list-profile', 'List Profile', 1, '2026-01-01T00:00:00Z').lastInsertRowid;

    seedBooking(app.db, profileId, { booker_name: 'Future Booker', start_time: '2099-12-01T10:00:00.000Z', end_time: '2099-12-01T10:30:00.000Z' });
    seedBooking(app.db, profileId, { booker_name: 'Past Booker', start_time: '2020-01-01T10:00:00.000Z', end_time: '2020-01-01T10:30:00.000Z' });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/bookings',
      headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Future Booker'));
    assert.ok(response.body.includes('Past Booker'));
    // Future booker should appear first
    const futureIdx = response.body.indexOf('Future Booker');
    const pastIdx = response.body.indexOf('Past Booker');
    assert.ok(futureIdx < pastIdx, 'Upcoming bookings should appear before past ones');

    app.db.prepare("DELETE FROM bookings").run();
    app.db.prepare("DELETE FROM booking_profiles").run();
  });

  it('each booking row shows date/time, duration, profile name, booker name, booker email, title, status', async () => {
    const profileId = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('row-profile', 'Row Profile', 1, '2026-01-01T00:00:00Z').lastInsertRowid;

    seedBooking(app.db, profileId, {
      booker_name: 'Detail Booker',
      booker_email: 'detail@test.com',
      title: 'Detail Meeting',
      duration_minutes: 45,
      status: 'confirmed',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/bookings',
      headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Detail Booker'));
    assert.ok(response.body.includes('detail@test.com'));
    assert.ok(response.body.includes('Detail Meeting'));
    assert.ok(response.body.includes('Row Profile'));
    assert.ok(response.body.includes('45'));
    assert.ok(response.body.includes('confirmed'));

    app.db.prepare("DELETE FROM bookings").run();
    app.db.prepare("DELETE FROM booking_profiles").run();
  });

  it('filters bookings by status', async () => {
    const profileId = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('filter-profile', 'Filter Profile', 1, '2026-01-01T00:00:00Z').lastInsertRowid;

    seedBooking(app.db, profileId, { booker_name: 'Confirmed Person', status: 'confirmed' });
    seedBooking(app.db, profileId, { booker_name: 'Cancelled Person', status: 'cancelled' });

    // Filter by confirmed
    const confirmed = await app.inject({
      method: 'GET',
      url: '/admin/bookings?status=confirmed',
      headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
    });
    assert.ok(confirmed.body.includes('Confirmed Person'));
    assert.ok(!confirmed.body.includes('Cancelled Person'));

    // Filter by cancelled
    const cancelled = await app.inject({
      method: 'GET',
      url: '/admin/bookings?status=cancelled',
      headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
    });
    assert.ok(cancelled.body.includes('Cancelled Person'));
    assert.ok(!cancelled.body.includes('Confirmed Person'));

    app.db.prepare("DELETE FROM bookings").run();
    app.db.prepare("DELETE FROM booking_profiles").run();
  });

  it('filters bookings by profile', async () => {
    const profileId1 = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('profile-a', 'Profile A', 1, '2026-01-01T00:00:00Z').lastInsertRowid;
    const profileId2 = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('profile-b', 'Profile B', 1, '2026-01-01T00:00:00Z').lastInsertRowid;

    seedBooking(app.db, profileId1, { booker_name: 'Profile A Booker' });
    seedBooking(app.db, profileId2, { booker_name: 'Profile B Booker' });

    const response = await app.inject({
      method: 'GET',
      url: `/admin/bookings?profile_id=${profileId1}`,
      headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
    });

    assert.ok(response.body.includes('Profile A Booker'));
    assert.ok(!response.body.includes('Profile B Booker'));

    app.db.prepare("DELETE FROM bookings").run();
    app.db.prepare("DELETE FROM booking_profiles").run();
  });

  it('shows cancelled status badge', async () => {
    const profileId = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('badge-profile', 'Badge Profile', 1, '2026-01-01T00:00:00Z').lastInsertRowid;

    seedBooking(app.db, profileId, { status: 'cancelled' });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/bookings',
      headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
    });

    assert.ok(response.body.includes('cancelled'));

    app.db.prepare("DELETE FROM bookings").run();
    app.db.prepare("DELETE FROM booking_profiles").run();
  });
});

describe('Admin Booking Cancellation - POST /admin/bookings/:id/cancel', () => {
  let app, sessionCookies;
  let deleteEventCalled;
  let deletedEventId;

  before(async () => {
    deleteEventCalled = false;
    deletedEventId = null;

    const mockFetch = (url, opts) => {
      if (typeof url === 'string' && url.includes('/calendars/primary/events/') && opts && opts.method === 'DELETE') {
        deleteEventCalled = true;
        deletedEventId = url.split('/events/')[1].split('?')[0];
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };

    app = createTestApp(mockFetch);
    await app.ready();
    const hash = await bcrypt.hash('test-pass', 10);
    app.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');
    sessionCookies = await login(app);
  });

  after(async () => {
    await app.close();
  });

  it('cancels a confirmed booking and updates status', async () => {
    const connId = app.db.prepare(
      "INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('google', encrypt('fake-token', ENCRYPTION_KEY), '', '2030-01-01T00:00:00Z', 'cal@test.com', 'connected').lastInsertRowid;

    const profileId = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, write_calendar_id, created_at) VALUES (?, ?, ?, ?, ?)").run('cancel-profile', 'Cancel Profile', 1, connId, '2026-01-01T00:00:00Z').lastInsertRowid;

    const bookingId = seedBooking(app.db, profileId, {
      status: 'confirmed',
      calendar_event_id: 'google-event-to-delete',
    });

    deleteEventCalled = false;
    deletedEventId = null;

    const { csrf, cookies } = await getCsrfAndCookies(app, '/admin/bookings', sessionCookies);

    const response = await app.inject({
      method: 'POST',
      url: `/admin/bookings/${bookingId}/cancel`,
      headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
      payload: { _csrf: csrf },
    });

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, '/admin/bookings');

    // Verify status updated in DB
    const booking = app.db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
    assert.equal(booking.status, 'cancelled');

    // Verify calendar event was deleted
    assert.ok(deleteEventCalled);
    assert.equal(deletedEventId, 'google-event-to-delete');

    app.db.prepare("DELETE FROM bookings").run();
    app.db.prepare("DELETE FROM booking_profiles").run();
    app.db.prepare("DELETE FROM calendar_connections WHERE id = ?").run(connId);
  });

  it('returns 404 for non-existent booking', async () => {
    const { csrf, cookies } = await getCsrfAndCookies(app, '/admin/dashboard', sessionCookies);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/bookings/99999/cancel',
      headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
      payload: { _csrf: csrf },
    });

    assert.equal(response.statusCode, 404);
  });

  it('does not cancel an already cancelled booking', async () => {
    const profileId = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('already-cancel', 'Already Cancel', 1, '2026-01-01T00:00:00Z').lastInsertRowid;

    const bookingId = seedBooking(app.db, profileId, { status: 'cancelled' });

    const { csrf, cookies } = await getCsrfAndCookies(app, '/admin/dashboard', sessionCookies);

    const response = await app.inject({
      method: 'POST',
      url: `/admin/bookings/${bookingId}/cancel`,
      headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
      payload: { _csrf: csrf },
    });

    assert.equal(response.statusCode, 400);

    app.db.prepare("DELETE FROM bookings").run();
    app.db.prepare("DELETE FROM booking_profiles").run();
  });
});
