const fastify = require('fastify');
const formbody = require('@fastify/formbody');
const cookie = require('@fastify/cookie');
const session = require('@fastify/session');
const csrf = require('@fastify/csrf-protection');
const bcrypt = require('bcrypt');
const { createDatabase } = require('./db');

const TIMEZONES = [
  'UTC',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Anchorage', 'America/Toronto', 'America/Vancouver', 'America/Sao_Paulo',
  'America/Mexico_City', 'America/Argentina/Buenos_Aires',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Zurich', 'Europe/Moscow',
  'Europe/Istanbul', 'Europe/Warsaw', 'Europe/Athens',
  'Asia/Istanbul', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai',
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Hong_Kong',
  'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland',
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos',
];

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const BASE_LAYOUT = (title, body) => `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - CalendarInvite</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
</head>
<body>
  <main class="container">
    ${body}
  </main>
</body>
</html>`;

function buildApp(opts = {}) {
  const app = fastify({ logger: opts.logger || false });

  const db = createDatabase(opts.dbPath || process.env.DB_PATH || './data/calendar-invite.db');

  app.decorate('db', db);

  app.register(formbody);
  app.register(cookie);
  const sessionSecret = opts.sessionSecret || process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET environment variable is required');
  }
  app.register(session, {
    secret: sessionSecret,
    cookie: { secure: false, httpOnly: true, sameSite: 'lax' },
  });
  app.register(csrf, { sessionPlugin: '@fastify/session' });

  app.get('/', async (request, reply) => {
    reply.type('text/html').send(BASE_LAYOUT('Home', `
      <h1>CalendarInvite</h1>
      <p>Self-hosted booking tool. Pico CSS powered.</p>
    `));
  });

  app.register(async function adminRoutes(app) {
    app.get('/login', async (request, reply) => {
      const token = reply.generateCsrf();
      reply.type('text/html').send(BASE_LAYOUT('Admin Login', `
        <h1>Admin Login</h1>
        <form method="POST" action="/admin/login">
          <input type="hidden" name="_csrf" value="${token}">
          <label>Username <input type="text" name="username" required></label>
          <label>Password <input type="password" name="password" required></label>
          <button type="submit">Login</button>
        </form>
      `));
    });

    app.post('/login', { preHandler: app.csrfProtection }, async (request, reply) => {
      const { username, password } = request.body || {};

      const admin = app.db.prepare('SELECT * FROM admin WHERE username = ?').get(username);
      if (!admin || !(await bcrypt.compare(password || '', admin.password_hash))) {
        const token = reply.generateCsrf();
        return reply.type('text/html').send(BASE_LAYOUT('Admin Login', `
          <h1>Admin Login</h1>
          <p style="color: var(--pico-color-red-500);">Invalid username or password</p>
          <form method="POST" action="/admin/login">
            <input type="hidden" name="_csrf" value="${token}">
            <label>Username <input type="text" name="username" required></label>
            <label>Password <input type="password" name="password" required></label>
            <button type="submit">Login</button>
          </form>
        `));
      }

      request.session.set('adminId', admin.id);
      return reply.redirect('/admin/dashboard');
    });

    app.addHook('preHandler', async (request, reply) => {
      if (request.url === '/admin/login') return;
      if (!request.session.get('adminId')) {
        return reply.redirect('/admin/login');
      }
    });

    app.get('/dashboard', async (request, reply) => {
      const token = reply.generateCsrf();
      reply.type('text/html').send(BASE_LAYOUT('Dashboard', `
        <h1>Dashboard</h1>
        <p>Welcome to the admin panel.</p>
        <form method="POST" action="/admin/logout">
          <input type="hidden" name="_csrf" value="${token}">
          <button type="submit">Logout</button>
        </form>
      `));
    });

    app.post('/logout', { preHandler: app.csrfProtection }, async (request, reply) => {
      await request.session.destroy();
      return reply.redirect('/admin/login');
    });

    app.get('/settings', async (request, reply) => {
      const adminId = request.session.get('adminId');
      const admin = app.db.prepare('SELECT timezone FROM admin WHERE id = ?').get(adminId);
      const token = reply.generateCsrf();
      const flash = request.session.get('flash') || '';
      request.session.set('flash', '');

      const timezoneOptions = TIMEZONES.map(tz =>
        `<option value="${tz}"${tz === admin.timezone ? ' selected' : ''}>${tz}</option>`
      ).join('');

      reply.type('text/html').send(BASE_LAYOUT('Settings', `
        <h1>Settings</h1>
        ${flash ? `<p role="alert">${escapeHtml(flash)}</p>` : ''}
        <section>
          <h2>Timezone</h2>
          <form method="POST" action="/admin/settings/timezone">
            <input type="hidden" name="_csrf" value="${token}">
            <label>Timezone
              <select name="timezone">${timezoneOptions}</select>
            </label>
            <button type="submit">Save Timezone</button>
          </form>
        </section>
        <section>
          <h2>Change Password</h2>
          <form method="POST" action="/admin/settings/password">
            <input type="hidden" name="_csrf" value="${token}">
            <label>Current Password <input type="password" name="current_password" required></label>
            <label>New Password <input type="password" name="new_password" required></label>
            <label>Confirm New Password <input type="password" name="confirm_password" required></label>
            <button type="submit">Change Password</button>
          </form>
        </section>
      `));
    });

    app.post('/settings/timezone', { preHandler: app.csrfProtection }, async (request, reply) => {
      const { timezone } = request.body || {};
      const adminId = request.session.get('adminId');

      if (!TIMEZONES.includes(timezone)) {
        request.session.set('flash', 'Invalid timezone selected');
        return reply.redirect('/admin/settings');
      }

      app.db.prepare('UPDATE admin SET timezone = ? WHERE id = ?').run(timezone, adminId);
      request.session.set('flash', 'Timezone updated successfully');
      return reply.redirect('/admin/settings');
    });

    app.post('/settings/password', { preHandler: app.csrfProtection }, async (request, reply) => {
      const { current_password, new_password, confirm_password } = request.body || {};
      const adminId = request.session.get('adminId');
      const admin = app.db.prepare('SELECT password_hash FROM admin WHERE id = ?').get(adminId);

      if (new_password !== confirm_password) {
        request.session.set('flash', 'New passwords do not match');
        return reply.redirect('/admin/settings');
      }

      const valid = await bcrypt.compare(current_password || '', admin.password_hash);
      if (!valid) {
        request.session.set('flash', 'Current password is incorrect');
        return reply.redirect('/admin/settings');
      }

      const newHash = await bcrypt.hash(new_password, 10);
      app.db.prepare('UPDATE admin SET password_hash = ? WHERE id = ?').run(newHash, adminId);
      request.session.set('flash', 'Password changed successfully');
      return reply.redirect('/admin/settings');
    });
  }, { prefix: '/admin' });

  app.register(async function publicRoutes(app) {
    app.get('/:slug', async (request, reply) => {
      const { slug } = request.params;
      const safeSlug = escapeHtml(slug);
      reply.type('text/html').send(BASE_LAYOUT(`Book - ${safeSlug}`, `
        <h1>Book a meeting</h1>
        <p>Booking page for <strong>${safeSlug}</strong></p>
      `));
    });
  }, { prefix: '/book' });

  app.addHook('onClose', () => {
    db.close();
  });

  return app;
}

module.exports = { buildApp };
