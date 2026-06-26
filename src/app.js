const fastify = require('fastify');
const formbody = require('@fastify/formbody');
const cookie = require('@fastify/cookie');
const session = require('@fastify/session');
const csrf = require('@fastify/csrf-protection');
const bcrypt = require('bcrypt');
const { createDatabase } = require('./db');
const { encrypt, decrypt } = require('./encryption');

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

  app.decorate('db', db);
  app.decorate('fetchFn', opts.fetchFn || globalThis.fetch);

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
      const connectionsHtml = connections.map(c => `
        <tr>
          <td>${escapeHtml(c.email || 'Unknown')}</td>
          <td>${escapeHtml(c.provider)}</td>
          <td>${escapeHtml(c.status)}</td>
          <td>
            <form method="POST" action="/admin/calendars/${c.id}/disconnect" style="margin:0">
              <input type="hidden" name="_csrf" value="${token}">
              <button type="submit" class="secondary outline">Disconnect</button>
            </form>
          </td>
        </tr>
      `).join('');

      reply.type('text/html').send(BASE_LAYOUT('Calendar Connections', `
        <h1>Calendar Connections</h1>
        ${connections.length > 0 ? `
          <table>
            <thead><tr><th>Email</th><th>Provider</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${connectionsHtml}</tbody>
          </table>
        ` : '<p>No calendar connections yet.</p>'}
        <a href="/admin/calendars/connect/microsoft" role="button">Connect Office 365 Calendar</a>
      `));
    });

    app.get('/calendars/connect/microsoft', async (request, reply) => {
      const clientId = opts.microsoftClientId || process.env.MICROSOFT_CLIENT_ID;
      const tenantId = opts.microsoftTenantId || process.env.MICROSOFT_TENANT_ID;
      const redirectUri = opts.microsoftRedirectUri || process.env.MICROSOFT_REDIRECT_URI;
      const scope = 'offline_access Calendars.ReadWrite User.Read';
      const authUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', scope);
      authUrl.searchParams.set('response_mode', 'query');
      return reply.redirect(authUrl.toString());
    });

    app.get('/calendars/callback/microsoft', async (request, reply) => {
      const { code } = request.query;
      if (!code) {
        return reply.status(400).send('Missing authorization code');
      }

      const clientId = opts.microsoftClientId || process.env.MICROSOFT_CLIENT_ID;
      const clientSecret = opts.microsoftClientSecret || process.env.MICROSOFT_CLIENT_SECRET;
      const tenantId = opts.microsoftTenantId || process.env.MICROSOFT_TENANT_ID;
      const redirectUri = opts.microsoftRedirectUri || process.env.MICROSOFT_REDIRECT_URI;

      const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
      const tokenResponse = await app.fetchFn(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          scope: 'offline_access Calendars.ReadWrite User.Read',
        }).toString(),
      });

      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok) {
        return reply.status(502).send('Failed to exchange authorization code');
      }

      const meResponse = await app.fetchFn('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const meData = await meResponse.json();

      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

      app.db.prepare(`
        INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        'microsoft',
        encrypt(tokenData.access_token, encryptionKey),
        encrypt(tokenData.refresh_token, encryptionKey),
        expiresAt,
        meData.mail || meData.userPrincipalName,
        'connected'
      );

      return reply.redirect('/admin/calendars');
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
