const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { buildApp } = require('../src/app');
const { encrypt } = require('../src/encryption');

const ENCRYPTION_KEY = 'a'.repeat(64);

// Always returns next Monday's date as YYYY-MM-DD (never today)
function getNextMonday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const daysUntilMonday = ((8 - d.getUTCDay()) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d.toISOString().split('T')[0];
}

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

describe('Rate Limiting - POST /api/book/:slug', () => {
  let app;

  before(async () => {
    const mockFetch = (url) => {
      if (typeof url === 'string' && url.includes('freeBusy')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ calendars: { primary: { busy: [] } } }) });
      }
      if (typeof url === 'string' && url.includes('/calendars/primary/events')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'event-' + Date.now() }) });
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

  it('6th booking from same email in 24h returns 429', async () => {
    const profileId = seedProfile(app.db, { slug: 'rate-email-test' });
    // Monday=1, schedule 09:00–17:00
    seedScheduleTemplate(app.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);

    // Make 5 successful bookings from the same email at different time slots
    for (let i = 0; i < 5; i++) {
      const hour = String(9 + i).padStart(2, '0');
      const response = await app.inject({
        method: 'POST',
        url: '/api/book/rate-email-test',
        headers: { 'content-type': 'application/json' },
        payload: {
          name: 'Rate Test',
          email: 'ratelimit@example.com',
          start_time: `${getNextMonday()}T${hour}:00:00.000Z`,
          duration: 30,
          timezone: 'UTC',
        },
      });
      assert.equal(response.statusCode, 200, `Booking ${i + 1} should succeed`);
    }

    // 6th booking should be rate limited
    const response = await app.inject({
      method: 'POST',
      url: '/api/book/rate-email-test',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'Rate Test',
        email: 'ratelimit@example.com',
        start_time: `${getNextMonday()}T14:00:00.000Z`,
        duration: 30,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 429);
    const data = JSON.parse(response.body);
    assert.ok(data.error.toLowerCase().includes('too many'));

    // Cleanup
    app.db.prepare("DELETE FROM rate_limits WHERE 1=1").run();
    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
  });

  it('21st request from same IP in 1 minute returns 429', async () => {
    const profileId = seedProfile(app.db, { slug: 'rate-ip-test' });
    seedScheduleTemplate(app.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);

    // Make 20 requests from the same IP (GET slots endpoint counts)
    for (let i = 0; i < 20; i++) {
      await app.inject({
        method: 'GET',
        url: `/api/book/rate-ip-test/slots?date=${getNextMonday()}&duration=30`,
        headers: { 'x-forwarded-for': '192.168.1.100' },
      });
    }

    // 21st request should be rate limited
    const response = await app.inject({
      method: 'GET',
      url: `/api/book/rate-ip-test/slots?date=${getNextMonday()}&duration=30`,
      headers: { 'x-forwarded-for': '192.168.1.100' },
    });

    assert.equal(response.statusCode, 429);
    const data = JSON.parse(response.body);
    assert.ok(data.error.toLowerCase().includes('too many'));

    // Cleanup
    app.db.prepare("DELETE FROM rate_limits WHERE 1=1").run();
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
  });

  it('rate limit entries older than window are cleaned up', async () => {
    const profileId = seedProfile(app.db, { slug: 'rate-cleanup-test' });
    seedScheduleTemplate(app.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);

    // Insert old rate limit entries (older than 24h)
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 10; i++) {
      app.db.prepare(
        "INSERT INTO rate_limits (key, type, endpoint, timestamp) VALUES (?, ?, ?, ?)"
      ).run('old@example.com', 'email', '/api/book/rate-cleanup-test', oldTime);
    }

    // Verify they exist
    const beforeCount = app.db.prepare("SELECT COUNT(*) as cnt FROM rate_limits WHERE key = 'old@example.com'").get().cnt;
    assert.equal(beforeCount, 10);

    // Make a request to trigger cleanup
    await app.inject({
      method: 'GET',
      url: `/api/book/rate-cleanup-test/slots?date=${getNextMonday()}&duration=30`,
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });

    // Old entries should be cleaned up
    const afterCount = app.db.prepare("SELECT COUNT(*) as cnt FROM rate_limits WHERE key = 'old@example.com'").get().cnt;
    assert.equal(afterCount, 0);

    // Cleanup
    app.db.prepare("DELETE FROM rate_limits WHERE 1=1").run();
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
  });

  it('different emails are rate limited independently', async () => {
    const profileId = seedProfile(app.db, { slug: 'rate-indep-test' });
    seedScheduleTemplate(app.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);

    // 5 bookings from email A
    for (let i = 0; i < 5; i++) {
      const hour = String(9 + i).padStart(2, '0');
      await app.inject({
        method: 'POST',
        url: '/api/book/rate-indep-test',
        headers: { 'content-type': 'application/json' },
        payload: {
          name: 'User A',
          email: 'usera@example.com',
          start_time: `${getNextMonday()}T${hour}:00:00.000Z`,
          duration: 30,
          timezone: 'UTC',
        },
      });
    }

    // Email B should still be allowed
    const response = await app.inject({
      method: 'POST',
      url: '/api/book/rate-indep-test',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'User B',
        email: 'userb@example.com',
        start_time: `${getNextMonday()}T14:00:00.000Z`,
        duration: 30,
        timezone: 'UTC',
      },
    });

    assert.equal(response.statusCode, 200);

    // Cleanup
    app.db.prepare("DELETE FROM rate_limits WHERE 1=1").run();
    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
  });

  it('concurrent booking attempts for same slot - one succeeds, other fails', async () => {
    const profileId = seedProfile(app.db, { slug: 'concurrent-test' });
    seedScheduleTemplate(app.db, profileId, [{ day: 1, start: '09:00', end: '17:00' }]);

    // Send two booking requests for the same slot concurrently
    const [response1, response2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/book/concurrent-test',
        headers: { 'content-type': 'application/json' },
        payload: {
          name: 'Racer One',
          email: 'racer1@example.com',
          start_time: `${getNextMonday()}T09:00:00.000Z`,
          duration: 30,
          timezone: 'UTC',
        },
      }),
      app.inject({
        method: 'POST',
        url: '/api/book/concurrent-test',
        headers: { 'content-type': 'application/json' },
        payload: {
          name: 'Racer Two',
          email: 'racer2@example.com',
          start_time: `${getNextMonday()}T09:00:00.000Z`,
          duration: 30,
          timezone: 'UTC',
        },
      }),
    ]);

    const statuses = [response1.statusCode, response2.statusCode].sort();
    assert.deepEqual(statuses, [200, 409], 'One should succeed (200) and one should fail (409)');

    // Cleanup
    app.db.prepare("DELETE FROM rate_limits WHERE 1=1").run();
    app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
    app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
  });
});
