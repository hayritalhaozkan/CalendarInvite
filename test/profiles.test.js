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

describe('Booking Profile CRUD', () => {
  let app;
  let sessionCookies;

  before(async () => {
    app = buildApp({ dbPath: ':memory:', sessionSecret: 'test-secret-that-is-at-least-32-characters-long', encryptionKey: 'a'.repeat(64) });
    await app.ready();

    const hash = await bcrypt.hash('test-pass', 10);
    app.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');

    sessionCookies = await login(app);
  });

  after(async () => {
    await app.close();
  });

  describe('GET /admin/profiles', () => {
    it('lists all booking profiles', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/profiles',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('Booking Profiles'));
    });

    it('shows created profiles with slug, name and status', async () => {
      app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('test-profile', 'Test Profile', 1, new Date().toISOString());

      const response = await app.inject({
        method: 'GET',
        url: '/admin/profiles',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('test-profile'));
      assert.ok(response.body.includes('Test Profile'));

      app.db.prepare("DELETE FROM booking_profiles WHERE slug = ?").run('test-profile');
    });
  });

  describe('GET /admin/profiles/new', () => {
    it('renders a creation form', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/profiles/new',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('name="slug"'));
      assert.ok(response.body.includes('name="name"'));
      assert.ok(response.body.includes('name="meeting_link_url"'));
    });
  });

  describe('POST /admin/profiles', () => {
    it('creates a new profile with valid data', async () => {
      const { token, cookies } = await getCsrf(app, '/admin/profiles/new', sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: '/admin/profiles',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          slug: 'my-meeting',
          name: 'My Meeting',
          meeting_link_url: 'https://meet.google.com/abc',
          meeting_tool: 'meet',
          _csrf: token,
        },
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/profiles');

      const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE slug = ?").get('my-meeting');
      assert.ok(profile);
      assert.equal(profile.name, 'My Meeting');
      assert.equal(profile.meeting_link_url, 'https://meet.google.com/abc');
      assert.equal(profile.meeting_tool, 'meet');
      assert.equal(profile.is_active, 1);

      app.db.prepare("DELETE FROM booking_profiles WHERE slug = ?").run('my-meeting');
    });

    it('rejects duplicate slugs', async () => {
      app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('existing-slug', 'Existing', 1, new Date().toISOString());

      const { token, cookies } = await getCsrf(app, '/admin/profiles/new', sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: '/admin/profiles',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          slug: 'existing-slug',
          name: 'Duplicate',
          _csrf: token,
        },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('slug already exists'));

      app.db.prepare("DELETE FROM booking_profiles WHERE slug = ?").run('existing-slug');
    });

    it('rejects invalid slugs', async () => {
      const { token, cookies } = await getCsrf(app, '/admin/profiles/new', sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: '/admin/profiles',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          slug: 'INVALID Slug!',
          name: 'Test',
          _csrf: token,
        },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('lowercase alphanumeric'));
    });

    it('creates profile with default attendees', async () => {
      const { token, cookies } = await getCsrf(app, '/admin/profiles/new', sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: '/admin/profiles',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          slug: 'with-attendees',
          name: 'With Attendees',
          'attendees[]': ['alice@example.com', 'bob@example.com'],
          _csrf: token,
        },
      });
      assert.equal(response.statusCode, 302);

      const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE slug = ?").get('with-attendees');
      const attendees = app.db.prepare("SELECT email FROM default_attendees WHERE profile_id = ?").all(profile.id);
      assert.equal(attendees.length, 2);
      assert.ok(attendees.some(a => a.email === 'alice@example.com'));
      assert.ok(attendees.some(a => a.email === 'bob@example.com'));

      app.db.prepare("DELETE FROM default_attendees WHERE profile_id = ?").run(profile.id);
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profile.id);
    });

    it('creates profile with schedule templates', async () => {
      const { token, cookies } = await getCsrf(app, '/admin/profiles/new', sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: '/admin/profiles',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          slug: 'with-schedule',
          name: 'With Schedule',
          'schedule[1][start][]': ['09:00', '14:00'],
          'schedule[1][end][]': ['12:00', '17:00'],
          'schedule[3][start][]': '10:00',
          'schedule[3][end][]': '16:00',
          _csrf: token,
        },
      });
      assert.equal(response.statusCode, 302);

      const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE slug = ?").get('with-schedule');
      const templates = app.db.prepare("SELECT * FROM schedule_templates WHERE profile_id = ? ORDER BY day_of_week, start_time").all(profile.id);
      const convertTimeToUTC = (timeStr) => {
        const [hours, minutes] = timeStr.split(':').map(Number);
        const now = new Date();
        const localDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);
        return `${String(localDate.getUTCHours()).padStart(2, '0')}:${String(localDate.getUTCMinutes()).padStart(2, '0')}`;
      };

      assert.equal(templates.length, 3);
      assert.equal(templates[0].day_of_week, 1);
      assert.equal(templates[0].start_time, convertTimeToUTC('09:00'));
      assert.equal(templates[0].end_time, convertTimeToUTC('12:00'));
      assert.equal(templates[1].day_of_week, 1);
      assert.equal(templates[1].start_time, convertTimeToUTC('14:00'));
      assert.equal(templates[1].end_time, convertTimeToUTC('17:00'));
      assert.equal(templates[2].day_of_week, 3);
      assert.equal(templates[2].start_time, convertTimeToUTC('10:00'));
      assert.equal(templates[2].end_time, convertTimeToUTC('16:00'));

      app.db.prepare("DELETE FROM schedule_templates WHERE profile_id = ?").run(profile.id);
      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profile.id);
    });
  });

  describe('GET /admin/profiles/:id/edit', () => {
    it('renders an edit form pre-filled with current values', async () => {
      const result = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, meeting_link_url, meeting_tool, created_at) VALUES (?, ?, ?, ?, ?, ?)").run('edit-me', 'Edit Me', 1, 'https://meet.google.com/xyz', 'meet', new Date().toISOString());
      const profileId = result.lastInsertRowid;

      const response = await app.inject({
        method: 'GET',
        url: `/admin/profiles/${profileId}/edit`,
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('edit-me'));
      assert.ok(response.body.includes('Edit Me'));
      assert.ok(response.body.includes('https://meet.google.com/xyz'));

      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('returns 404 for non-existent profile', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/profiles/99999/edit',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 404);
    });
  });

  describe('POST /admin/profiles/:id', () => {
    it('updates the profile', async () => {
      const result = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('update-me', 'Old Name', 1, new Date().toISOString());
      const profileId = result.lastInsertRowid;

      const { token, cookies } = await getCsrf(app, `/admin/profiles/${profileId}/edit`, sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: `/admin/profiles/${profileId}`,
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          slug: 'updated-slug',
          name: 'New Name',
          meeting_link_url: 'https://teams.microsoft.com/new',
          meeting_tool: 'teams',
          _csrf: token,
        },
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/profiles');

      const updated = app.db.prepare("SELECT * FROM booking_profiles WHERE id = ?").get(profileId);
      assert.equal(updated.slug, 'updated-slug');
      assert.equal(updated.name, 'New Name');
      assert.equal(updated.meeting_tool, 'teams');

      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });
  });

  describe('POST /admin/profiles/:id/delete', () => {
    it('deletes the profile and associated data', async () => {
      const result = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('delete-me', 'Delete Me', 1, new Date().toISOString());
      const profileId = result.lastInsertRowid;

      app.db.prepare("INSERT INTO default_attendees (profile_id, email) VALUES (?, ?)").run(profileId, 'x@test.com');
      app.db.prepare("INSERT INTO schedule_templates (profile_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)").run(profileId, 1, '09:00', '17:00');

      const { token, cookies } = await getCsrf(app, `/admin/profiles/${profileId}/edit`, sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: `/admin/profiles/${profileId}/delete`,
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: { _csrf: token },
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/profiles');

      const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE id = ?").get(profileId);
      assert.equal(profile, undefined);

      const attendees = app.db.prepare("SELECT * FROM default_attendees WHERE profile_id = ?").all(profileId);
      assert.equal(attendees.length, 0);

      const templates = app.db.prepare("SELECT * FROM schedule_templates WHERE profile_id = ?").all(profileId);
      assert.equal(templates.length, 0);
    });
  });

  describe('POST /admin/profiles/:id/toggle', () => {
    it('toggles active to inactive', async () => {
      const result = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('toggle-me', 'Toggle', 1, new Date().toISOString());
      const profileId = result.lastInsertRowid;

      const { token, cookies } = await getCsrf(app, `/admin/profiles/${profileId}/edit`, sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: `/admin/profiles/${profileId}/toggle`,
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: { _csrf: token },
      });
      assert.equal(response.statusCode, 302);

      const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE id = ?").get(profileId);
      assert.equal(profile.is_active, 0);

      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });

    it('toggles inactive to active', async () => {
      const result = app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('toggle-me-2', 'Toggle 2', 0, new Date().toISOString());
      const profileId = result.lastInsertRowid;

      const { token, cookies } = await getCsrf(app, `/admin/profiles/${profileId}/edit`, sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: `/admin/profiles/${profileId}/toggle`,
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: { _csrf: token },
      });
      assert.equal(response.statusCode, 302);

      const profile = app.db.prepare("SELECT * FROM booking_profiles WHERE id = ?").get(profileId);
      assert.equal(profile.is_active, 1);

      app.db.prepare("DELETE FROM booking_profiles WHERE id = ?").run(profileId);
    });
  });

  describe('Calendar selection', () => {
    it('populates calendar dropdowns from existing connections', async () => {
      app.db.prepare("INSERT INTO calendar_connections (provider, email, status) VALUES (?, ?, ?)").run('google', 'cal@gmail.com', 'connected');

      const response = await app.inject({
        method: 'GET',
        url: '/admin/profiles/new',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('cal@gmail.com'));

      app.db.prepare("DELETE FROM calendar_connections").run();
    });
  });
});
