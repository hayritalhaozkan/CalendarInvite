const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { buildApp } = require('../src/app');

function createTestApp(fetchFn) {
  return buildApp({
    dbPath: ':memory:',
    sessionSecret: 'test-secret-that-is-at-least-32-characters-long',
    encryptionKey: 'a'.repeat(64),
    fetchFn: fetchFn || (() => Promise.resolve({ ok: true, json: () => Promise.resolve({ calendars: { primary: { busy: [] } } }) })),
  });
}

function seedProfile(db, overrides = {}) {
  const defaults = { slug: 'test-profile', name: 'Test Profile', is_active: 1 };
  const { slug, name, is_active } = { ...defaults, ...overrides };
  const result = db.prepare(
    "INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)"
  ).run(slug, name, is_active, '2026-01-01T00:00:00.000Z');
  return result.lastInsertRowid;
}

function seedScheduleTemplate(db, profileId, entries) {
  const stmt = db.prepare("INSERT INTO schedule_templates (profile_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)");
  for (const entry of entries) {
    stmt.run(profileId, entry.day, entry.start, entry.end);
  }
}

function seedOverride(db, profileId, { date, is_blocked, custom_ranges }) {
  db.prepare("INSERT INTO schedule_overrides (profile_id, date, is_blocked, custom_ranges) VALUES (?, ?, ?, ?)")
    .run(profileId, date, is_blocked ? 1 : 0, custom_ranges ? JSON.stringify(custom_ranges) : null);
}

function seedBooking(db, profileId, { start_time, end_time, duration_minutes }) {
  db.prepare(
    "INSERT INTO bookings (profile_id, booker_name, booker_email, title, start_time, end_time, duration_minutes, cancellation_token, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(profileId, 'Test Booker', 'booker@test.com', 'Test Meeting', start_time, end_time, duration_minutes, `cancel-${Date.now()}-${Math.random()}`, 'confirmed', new Date().toISOString());
}

describe('Public Booking Page', () => {
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

  describe('GET /book/:slug', () => {
    it('renders the booking page for an active profile', async () => {
      const profileId = seedProfile(app.db);
      const response = await app.inject({ method: 'GET', url: '/book/test-profile' });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('Test Profile'));
      assert.ok(response.body.includes('30'));
      assert.ok(response.body.includes('45'));
      assert.ok(response.body.includes('60'));
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('shows not accepting message for inactive profile', async () => {
      const profileId = seedProfile(app.db, { slug: 'inactive', is_active: 0 });
      const response = await app.inject({ method: 'GET', url: '/book/inactive' });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('Not currently accepting bookings'));
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('returns 404 for non-existent slug', async () => {
      const response = await app.inject({ method: 'GET', url: '/book/nonexistent' });
      assert.equal(response.statusCode, 404);
    });
  });
});

describe('Availability Slots API', () => {
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

  describe('GET /api/book/:slug/slots', () => {
    it('returns 404 for non-existent slug', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/book/nonexistent/slots?date=2026-07-01&duration=30',
      });
      assert.equal(response.statusCode, 404);
    });

    it('returns 400 if date or duration missing', async () => {
      const profileId = seedProfile(app.db, { slug: 'slots-test' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/book/slots-test/slots',
      });
      assert.equal(response.statusCode, 400);
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('returns 400 for invalid duration', async () => {
      const profileId = seedProfile(app.db, { slug: 'slots-dur' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/book/slots-dur/slots?date=2026-07-01&duration=20',
      });
      assert.equal(response.statusCode, 400);
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('returns slots from schedule template', async () => {
      const profileId = seedProfile(app.db, { slug: 'template-slots' });
      // 2026-07-06 is a Monday (day_of_week=1)
      seedScheduleTemplate(app.db, profileId, [
        { day: 1, start: '09:00', end: '12:00' },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/book/template-slots/slots?date=2026-07-06&duration=30&timezone=UTC',
      });
      assert.equal(response.statusCode, 200);
      const data = JSON.parse(response.body);
      assert.ok(Array.isArray(data.slots));
      assert.ok(data.slots.length > 0);
      // 09:00-12:00 = 3 hours = 6 slots of 30 min
      assert.equal(data.slots.length, 6);
      assert.equal(data.slots[0].start, '2026-07-06T09:00:00.000Z');
      assert.equal(data.slots[0].end, '2026-07-06T09:30:00.000Z');
      assert.equal(data.slots[5].start, '2026-07-06T11:30:00.000Z');
      assert.equal(data.slots[5].end, '2026-07-06T12:00:00.000Z');

      app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('returns empty slots when no template for that day', async () => {
      const profileId = seedProfile(app.db, { slug: 'no-template' });
      // 2026-07-06 is Monday (day=1), but we set template for Tuesday (day=2)
      seedScheduleTemplate(app.db, profileId, [
        { day: 2, start: '09:00', end: '12:00' },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/book/no-template/slots?date=2026-07-06&duration=30&timezone=UTC',
      });
      assert.equal(response.statusCode, 200);
      const data = JSON.parse(response.body);
      assert.equal(data.slots.length, 0);

      app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('applies blocked override to remove all slots', async () => {
      const profileId = seedProfile(app.db, { slug: 'blocked-day' });
      seedScheduleTemplate(app.db, profileId, [
        { day: 1, start: '09:00', end: '12:00' },
      ]);
      seedOverride(app.db, profileId, { date: '2026-07-06', is_blocked: true });

      const response = await app.inject({
        method: 'GET',
        url: '/api/book/blocked-day/slots?date=2026-07-06&duration=30&timezone=UTC',
      });
      assert.equal(response.statusCode, 200);
      const data = JSON.parse(response.body);
      assert.equal(data.slots.length, 0);

      app.db.prepare("DELETE FROM schedule_overrides WHERE profile_id = ?").run(profileId);
      app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('applies custom range override', async () => {
      const profileId = seedProfile(app.db, { slug: 'custom-override' });
      seedScheduleTemplate(app.db, profileId, [
        { day: 1, start: '09:00', end: '17:00' },
      ]);
      seedOverride(app.db, profileId, {
        date: '2026-07-06',
        is_blocked: false,
        custom_ranges: [{ start: '10:00', end: '12:00' }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/book/custom-override/slots?date=2026-07-06&duration=30&timezone=UTC',
      });
      assert.equal(response.statusCode, 200);
      const data = JSON.parse(response.body);
      // Custom override replaces template: only 10:00-12:00 = 4 slots
      assert.equal(data.slots.length, 4);
      assert.equal(data.slots[0].start, '2026-07-06T10:00:00.000Z');

      app.db.prepare("DELETE FROM schedule_overrides WHERE profile_id = ?").run(profileId);
      app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('removes slots conflicting with existing bookings', async () => {
      const profileId = seedProfile(app.db, { slug: 'booking-conflict' });
      seedScheduleTemplate(app.db, profileId, [
        { day: 1, start: '09:00', end: '12:00' },
      ]);
      // Book 09:00-09:30
      seedBooking(app.db, profileId, {
        start_time: '2026-07-06T09:00:00.000Z',
        end_time: '2026-07-06T09:30:00.000Z',
        duration_minutes: 30,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/book/booking-conflict/slots?date=2026-07-06&duration=30&timezone=UTC',
      });
      assert.equal(response.statusCode, 200);
      const data = JSON.parse(response.body);
      // 6 slots - 1 booked = 5
      assert.equal(data.slots.length, 5);
      assert.equal(data.slots[0].start, '2026-07-06T09:30:00.000Z');

      app.db.prepare("DELETE FROM bookings WHERE profile_id = ?").run(profileId);
      app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('filters out slots within 2-hour lead time', async () => {
      const profileId = seedProfile(app.db, { slug: 'lead-time' });
      // Use today's date and set template for today's day of week
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const dayOfWeek = now.getUTCDay();

      // Set a range from now-1h to now+4h (only slots starting >= now+2h should appear)
      const startHour = now.getUTCHours() - 1;
      const endHour = now.getUTCHours() + 4;
      if (startHour < 0 || endHour > 24) {
        // Skip test if times are awkward
        app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
        return;
      }

      const startTime = `${String(startHour).padStart(2, '0')}:00`;
      const endTime = `${String(endHour).padStart(2, '0')}:00`;

      seedScheduleTemplate(app.db, profileId, [
        { day: dayOfWeek, start: startTime, end: endTime },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: `/api/book/lead-time/slots?date=${today}&duration=30&timezone=UTC`,
      });
      assert.equal(response.statusCode, 200);
      const data = JSON.parse(response.body);

      // All returned slots must start at least 2 hours from now
      const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      for (const slot of data.slots) {
        assert.ok(new Date(slot.start) >= twoHoursFromNow, `Slot ${slot.start} is within 2-hour lead time`);
      }

      app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('filters out slots beyond 4-week horizon', async () => {
      const profileId = seedProfile(app.db, { slug: 'horizon' });
      // Date 5 weeks from now
      const futureDate = new Date(Date.now() + 5 * 7 * 24 * 60 * 60 * 1000);
      const dateStr = futureDate.toISOString().split('T')[0];
      const dayOfWeek = futureDate.getUTCDay();

      seedScheduleTemplate(app.db, profileId, [
        { day: dayOfWeek, start: '09:00', end: '12:00' },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: `/api/book/horizon/slots?date=${dateStr}&duration=30&timezone=UTC`,
      });
      assert.equal(response.statusCode, 200);
      const data = JSON.parse(response.body);
      assert.equal(data.slots.length, 0);

      app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('filters slots by duration (60 min must fit in window)', async () => {
      const profileId = seedProfile(app.db, { slug: 'duration-fit' });
      // 09:00-10:00 = only 2 slots of 30 min, or 1 slot of 60 min
      seedScheduleTemplate(app.db, profileId, [
        { day: 1, start: '09:00', end: '10:00' },
      ]);

      const response30 = await app.inject({
        method: 'GET',
        url: '/api/book/duration-fit/slots?date=2026-07-06&duration=30&timezone=UTC',
      });
      const data30 = JSON.parse(response30.body);
      assert.equal(data30.slots.length, 2);

      const response60 = await app.inject({
        method: 'GET',
        url: '/api/book/duration-fit/slots?date=2026-07-06&duration=60&timezone=UTC',
      });
      const data60 = JSON.parse(response60.body);
      assert.equal(data60.slots.length, 1);

      const response45 = await app.inject({
        method: 'GET',
        url: '/api/book/duration-fit/slots?date=2026-07-06&duration=45&timezone=UTC',
      });
      const data45 = JSON.parse(response45.body);
      assert.equal(data45.slots.length, 1);

      app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profileId);
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('removes slots conflicting with calendar busy events', async () => {
      const mockFetch = (url, opts) => {
        if (typeof url === 'string' && url.includes('freeBusy')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              calendars: {
                primary: {
                  busy: [
                    { start: '2026-07-06T09:00:00Z', end: '2026-07-06T10:00:00Z' },
                  ],
                },
              },
            }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      };

      const calApp = createTestApp(mockFetch);
      await calApp.ready();
      const hash = await bcrypt.hash('test-pass', 10);
      calApp.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');

      const profileId = seedProfile(calApp.db, { slug: 'cal-conflict' });
      seedScheduleTemplate(calApp.db, profileId, [
        { day: 1, start: '09:00', end: '12:00' },
      ]);

      // Add a calendar connection and link it as read calendar
      const connResult = calApp.db.prepare(
        "INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)"
      ).run('google', 'enc-access', 'enc-refresh', '2030-01-01T00:00:00.000Z', 'test@gmail.com', 'connected');
      const connId = connResult.lastInsertRowid;
      calApp.db.prepare("INSERT INTO profile_read_calendars (profile_id, calendar_connection_id) VALUES (?, ?)").run(profileId, connId);

      const response = await calApp.inject({
        method: 'GET',
        url: '/api/book/cal-conflict/slots?date=2026-07-06&duration=30&timezone=UTC',
      });
      assert.equal(response.statusCode, 200);
      const data = JSON.parse(response.body);
      // 09:00-10:00 blocked by busy => only 10:00-12:00 = 4 slots
      assert.equal(data.slots.length, 4);
      assert.equal(data.slots[0].start, '2026-07-06T10:00:00.000Z');

      await calApp.close();
    });
  });
});
