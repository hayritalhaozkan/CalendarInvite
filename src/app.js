const fastify = require('fastify');
const formbody = require('@fastify/formbody');
const cookie = require('@fastify/cookie');
const session = require('@fastify/session');
const csrf = require('@fastify/csrf-protection');
const bcrypt = require('bcrypt');
const { createDatabase } = require('./db');
const { buildGoogleAuthUrl, exchangeCodeForTokens, getGoogleUserEmail } = require('./google');
const { encrypt } = require('./encryption');

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
  const encryptionKey = opts.encryptionKey || process.env.TOKEN_ENCRYPTION_KEY;
  const googleClientId = opts.googleClientId || process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = opts.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET;
  const googleRedirectUri = opts.googleRedirectUri || process.env.GOOGLE_REDIRECT_URI;

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

    app.get('/calendars', async (request, reply) => {
      const connections = app.db.prepare('SELECT * FROM calendar_connections').all();
      const token = reply.generateCsrf();
      const connectionRows = connections.map(c => `
        <tr>
          <td>${escapeHtml(c.provider)}</td>
          <td>${escapeHtml(c.email || '')}</td>
          <td>${escapeHtml(c.status)}</td>
          <td>
            <form method="POST" action="/admin/calendars/${c.id}/disconnect" style="display:inline">
              <input type="hidden" name="_csrf" value="${token}">
              <button type="submit" class="secondary outline">Disconnect</button>
            </form>
          </td>
        </tr>
      `).join('');

      reply.type('text/html').send(BASE_LAYOUT('Calendar Connections', `
        <h1>Calendar Connections</h1>
        <a href="/admin/calendars/connect/google" role="button">Connect Google Calendar</a>
        ${connections.length ? `
          <table>
            <thead><tr><th>Provider</th><th>Email</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${connectionRows}</tbody>
          </table>
        ` : '<p>No calendar connections yet.</p>'}
      `));
    });

    app.get('/calendars/connect/google', async (request, reply) => {
      const url = buildGoogleAuthUrl(googleClientId, googleRedirectUri);
      return reply.redirect(url);
    });

    app.get('/calendars/callback/google', async (request, reply) => {
      const { code } = request.query;
      try {
        const tokens = await exchangeCodeForTokens(code, googleClientId, googleClientSecret, googleRedirectUri);
        const email = await getGoogleUserEmail(tokens.access_token);
        const tokenExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

        const encryptedAccess = encrypt(tokens.access_token, encryptionKey);
        const encryptedRefresh = encrypt(tokens.refresh_token, encryptionKey);

        app.db.prepare(
          'INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('google', encryptedAccess, encryptedRefresh, tokenExpiry, email, 'connected');

        return reply.redirect('/admin/calendars');
      } catch (err) {
        request.log.error(err);
        return reply.redirect('/admin/calendars?error=oauth_failed');
      }
    });

    app.post('/calendars/:id/disconnect', { preHandler: app.csrfProtection }, async (request, reply) => {
      const { id } = request.params;
      app.db.prepare('DELETE FROM calendar_connections WHERE id = ?').run(id);
      return reply.redirect('/admin/calendars');
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
