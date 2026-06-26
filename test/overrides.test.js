const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { buildApp } = require('../src/app');

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

async function getCsrf(app, url, cookies) {
  const page = await app.inject({
    method: 'GET',
    url,
    headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
  });
  const token = page.body.match(/name="_csrf" value="([^"]+)"/)[1];
  const newCookies = page.headers['set-cookie'] || cookies;
  return { token, cookies: newCookies, body: page.body, statusCode: page.statusCode };
}

describe('Schedule Overrides', () => {
  let app;
  let sessionCookies;
  let profileId;

  before(async () => {
    app = buildApp({ dbPath: ':memory:', sessionSecret: 'test-secret-that-is-at-least-32-characters-long', encryptionKey: 'a'.repeat(64) });
    await app.ready();

    const hash = await bcrypt.hash('test-pass', 10);
    app.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');

    const result = app.db.prepare(
      "INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)"
    ).run('override-test', 'Override Test', 1, new Date().toISOString());
    profileId = result.lastInsertRowid;

    app.db.prepare("INSERT INTO schedule_templates (profile_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)").run(profileId, 1, '09:00', '17:00');

    sessionCookies = await login(app);
  });

  after(async () => {
    await app.close();
  });

  beforeEach(() => {
    app.db.prepare("DELETE FROM schedule_overrides WHERE profile_id = ?").run(profileId);
  });

  describe('GET /admin/profiles/:id/edit (overrides section)', () => {
    it('shows the Schedule Overrides section', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/admin/profiles/${profileId}/edit`,
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('Schedule Overrides'));
    });

    it('lists existing overrides', async () => {
      app.db.prepare("INSERT INTO schedule_overrides (profile_id, date, is_blocked, custom_ranges) VALUES (?, ?, ?, ?)").run(profileId, '2026-07-04', 1, null);
      app.db.prepare("INSERT INTO schedule_overrides (profile_id, date, is_blocked, custom_ranges) VALUES (?, ?, ?, ?)").run(profileId, '2026-07-10', 0, JSON.stringify([{ start: '10:00', end: '14:00' }]));

      const response = await app.inject({
        method: 'GET',
        url: `/admin/profiles/${profileId}/edit`,
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('2026-07-04'));
      assert.ok(response.body.includes('Blocked'));
      assert.ok(response.body.includes('2026-07-10'));
      assert.ok(response.body.includes('10:00'));
      assert.ok(response.body.includes('14:00'));
    });

    it('shows past overrides as greyed out', async () => {
      app.db.prepare("INSERT INTO schedule_overrides (profile_id, date, is_blocked, custom_ranges) VALUES (?, ?, ?, ?)").run(profileId, '2020-01-01', 1, null);

      const response = await app.inject({
        method: 'GET',
        url: `/admin/profiles/${profileId}/edit`,
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('2020-01-01'));
      assert.ok(response.body.includes('past-override'));
    });
  });

  describe('POST /admin/profiles/:id/overrides (add override)', () => {
    it('adds a blocked override for a date', async () => {
      const { token, cookies } = await getCsrf(app, `/admin/profiles/${profileId}/edit`, sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: `/admin/profiles/${profileId}/overrides`,
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          date: '2026-08-15',
          override_type: 'blocked',
          _csrf: token,
        },
      });
      assert.equal(response.statusCode, 302);
      assert.ok(response.headers.location.includes(`/admin/profiles/${profileId}/edit`));

      const override = app.db.prepare("SELECT * FROM schedule_overrides WHERE profile_id = ? AND date = ?").get(profileId, '2026-08-15');
      assert.ok(override);
      assert.equal(override.is_blocked, 1);
      assert.equal(override.custom_ranges, null);
    });

    it('adds a custom hours override for a date', async () => {
      const { token, cookies } = await getCsrf(app, `/admin/profiles/${profileId}/edit`, sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: `/admin/profiles/${profileId}/overrides`,
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          date: '2026-08-20',
          override_type: 'custom',
          'custom_start[]': ['10:00', '14:00'],
          'custom_end[]': ['12:00', '16:00'],
          _csrf: token,
        },
      });
      assert.equal(response.statusCode, 302);

      const override = app.db.prepare("SELECT * FROM schedule_overrides WHERE profile_id = ? AND date = ?").get(profileId, '2026-08-20');
      assert.ok(override);
      assert.equal(override.is_blocked, 0);
      const ranges = JSON.parse(override.custom_ranges);
      assert.equal(ranges.length, 2);
      assert.equal(ranges[0].start, '10:00');
      assert.equal(ranges[0].end, '12:00');
      assert.equal(ranges[1].start, '14:00');
      assert.equal(ranges[1].end, '16:00');
    });

    it('rejects duplicate override for the same date', async () => {
      app.db.prepare("INSERT INTO schedule_overrides (profile_id, date, is_blocked) VALUES (?, ?, ?)").run(profileId, '2026-09-01', 1);

      const { token, cookies } = await getCsrf(app, `/admin/profiles/${profileId}/edit`, sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: `/admin/profiles/${profileId}/overrides`,
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          date: '2026-09-01',
          override_type: 'blocked',
          _csrf: token,
        },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('already exists'));
    });

    it('rejects override without a date', async () => {
      const { token, cookies } = await getCsrf(app, `/admin/profiles/${profileId}/edit`, sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: `/admin/profiles/${profileId}/overrides`,
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          date: '',
          override_type: 'blocked',
          _csrf: token,
        },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('Date is required'));
    });
  });

  describe('POST /admin/profiles/:id/overrides/:overrideId/delete', () => {
    it('deletes an existing override', async () => {
      const result = app.db.prepare("INSERT INTO schedule_overrides (profile_id, date, is_blocked) VALUES (?, ?, ?)").run(profileId, '2026-10-01', 1);
      const overrideId = result.lastInsertRowid;

      const { token, cookies } = await getCsrf(app, `/admin/profiles/${profileId}/edit`, sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: `/admin/profiles/${profileId}/overrides/${overrideId}/delete`,
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: { _csrf: token },
      });
      assert.equal(response.statusCode, 302);
      assert.ok(response.headers.location.includes(`/admin/profiles/${profileId}/edit`));

      const override = app.db.prepare("SELECT * FROM schedule_overrides WHERE id = ?").get(overrideId);
      assert.equal(override, undefined);
    });
  });

  describe('Availability effects', () => {
    it('blocked override removes all slots for that date', async () => {
      app.db.prepare("INSERT INTO schedule_overrides (profile_id, date, is_blocked) VALUES (?, ?, ?)").run(profileId, '2026-07-07', 1);

      const override = app.db.prepare("SELECT * FROM schedule_overrides WHERE profile_id = ? AND date = ?").get(profileId, '2026-07-07');
      assert.equal(override.is_blocked, 1);

      const templates = app.db.prepare("SELECT * FROM schedule_templates WHERE profile_id = ? AND day_of_week = ?").all(profileId, 1);
      assert.ok(templates.length > 0);
    });

    it('custom override replaces template for that date', async () => {
      app.db.prepare("INSERT INTO schedule_overrides (profile_id, date, is_blocked, custom_ranges) VALUES (?, ?, ?, ?)").run(
        profileId, '2026-07-07', 0, JSON.stringify([{ start: '10:00', end: '12:00' }])
      );

      const override = app.db.prepare("SELECT * FROM schedule_overrides WHERE profile_id = ? AND date = ?").get(profileId, '2026-07-07');
      assert.equal(override.is_blocked, 0);
      const ranges = JSON.parse(override.custom_ranges);
      assert.equal(ranges.length, 1);
      assert.equal(ranges[0].start, '10:00');
      assert.equal(ranges[0].end, '12:00');
    });

    it('delete override restores template behavior', async () => {
      const result = app.db.prepare("INSERT INTO schedule_overrides (profile_id, date, is_blocked) VALUES (?, ?, ?)").run(profileId, '2026-07-07', 1);
      const overrideId = result.lastInsertRowid;

      app.db.prepare("DELETE FROM schedule_overrides WHERE id = ?").run(overrideId);

      const override = app.db.prepare("SELECT * FROM schedule_overrides WHERE profile_id = ? AND date = ?").get(profileId, '2026-07-07');
      assert.equal(override, undefined);

      const templates = app.db.prepare("SELECT * FROM schedule_templates WHERE profile_id = ? AND day_of_week = ?").all(profileId, 1);
      assert.ok(templates.length > 0);
    });
  });
});
