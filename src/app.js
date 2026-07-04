const crypto = require('node:crypto');
const path = require('node:path');
const fastify = require('fastify');
const formbody = require('@fastify/formbody');
const cookie = require('@fastify/cookie');
const session = require('@fastify/session');
const csrf = require('@fastify/csrf-protection');
const fastifyStatic = require('@fastify/static');
const bcrypt = require('bcrypt');
const { createDatabase } = require('./db');
const { buildGoogleAuthUrl, exchangeCodeForTokens, getGoogleUserEmail } = require('./google');
const { encrypt, decrypt } = require('./encryption');
const { registerProfileRoutes } = require('./profiles');
const { registerBookingRoutes, registerSlotsApi, registerBookingSubmitApi, registerCancellationPage, registerCancellationApi, registerRateLimitHook } = require('./booking');


const TIMEZONES = [
  'UTC',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Anchorage', 'America/Toronto', 'America/Vancouver', 'America/Sao_Paulo',
  'America/Mexico_City', 'America/Argentina/Buenos_Aires',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Zurich', 'Europe/Moscow',
  'Europe/Istanbul', 'Europe/Warsaw', 'Europe/Athens',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai',
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Hong_Kong',
  'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland',
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos',
];

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const BASE_LAYOUT = (title, body) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - CalendarInvite</title>
  <link rel="stylesheet" href="/css/styles.css">
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
  const zohoClientId = opts.zohoClientId || process.env.ZOHO_CLIENT_ID;
  const zohoClientSecret = opts.zohoClientSecret || process.env.ZOHO_CLIENT_SECRET;
  const zohoRedirectUri = opts.zohoRedirectUri || process.env.ZOHO_REDIRECT_URI;

  app.decorate('db', db);
  app.decorate('fetchFn', opts.fetchFn || globalThis.fetch);
  app.decorate('zohoFetch', null);

  app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  app.register(formbody);
  app.register(cookie);
  const sessionSecret = opts.sessionSecret || process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET environment variable is required');
  }
  if (!encryptionKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY environment variable is required');
  }
  app.register(session, {
    secret: sessionSecret,
    cookie: { secure: false, httpOnly: true, sameSite: 'lax' },
  });
  app.register(csrf, { sessionPlugin: '@fastify/session' });

  app.get('/', async (request, reply) => {
    reply.type('text/html').send(BASE_LAYOUT('Home', `
      <div style="text-align: center; padding: 4rem 0;">
        <h1 style="font-size: 3rem; margin-bottom: 1rem;">CalendarInvite</h1>
        <p style="font-size: 1.25rem; color: var(--text-secondary); margin-bottom: 2rem;">Modern self-hosted booking solution</p>
        <p style="max-width: 600px; margin: 0 auto 2rem;">
          Seamlessly manage your availability and let others book time with you.
          Connect your calendar, set your schedule, and share your booking link.
        </p>
        <a href="/admin/login" role="button">Admin Login</a>
      </div>
    `));
  });

  app.register(async function adminRoutes(app) {
    app.setErrorHandler(async (error, request, reply) => {
      if ((error.code === 'FST_CSRF_MISSING_SECRET' || error.code === 'FST_CSRF_INVALID_TOKEN') && request.url === '/admin/login') {
        return reply.redirect('/admin/login');
      }
      reply.code(error.statusCode || 500).send({ statusCode: error.statusCode || 500, error: error.name, message: error.message });
    });

    app.get('/login', async (request, reply) => {
      const token = reply.generateCsrf();
      reply.type('text/html').send(BASE_LAYOUT('Admin Login', `
        <div style="max-width: 450px; margin: 4rem auto;">
          <article>
            <h1 style="text-align: center; margin-bottom: 2rem;">CalendarInvite</h1>
            <h2 style="text-align: center; font-size: 1.25rem; margin-bottom: 2rem; color: var(--text-secondary);">Admin Login</h2>
            <form method="POST" action="/admin/login">
              <input type="hidden" name="_csrf" value="${token}">
              <label>
                Username
                <input type="text" name="username" placeholder="Enter your username" required autofocus>
              </label>
              <label>
                Password
                <input type="password" name="password" placeholder="Enter your password" required>
              </label>
              <button type="submit" style="width: 100%;">Sign In</button>
            </form>
          </article>
        </div>
      `));
    });

    app.post('/login', { preHandler: app.csrfProtection }, async (request, reply) => {
      const { username, password } = request.body || {};

      const admin = app.db.prepare('SELECT * FROM admin WHERE username = ?').get(username);
      if (!admin || !(await bcrypt.compare(password || '', admin.password_hash))) {
        const token = reply.generateCsrf();
        return reply.type('text/html').send(BASE_LAYOUT('Admin Login', `
          <div style="max-width: 450px; margin: 4rem auto;">
            <article>
              <h1 style="text-align: center; margin-bottom: 2rem;">CalendarInvite</h1>
              <h2 style="text-align: center; font-size: 1.25rem; margin-bottom: 2rem; color: var(--text-secondary);">Admin Login</h2>
              <div role="alert" class="error">
                Invalid username or password. Please try again.
              </div>
              <form method="POST" action="/admin/login">
                <input type="hidden" name="_csrf" value="${token}">
                <label>
                  Username
                  <input type="text" name="username" placeholder="Enter your username" value="${escapeHtml(username || '')}" required autofocus>
                </label>
                <label>
                  Password
                  <input type="password" name="password" placeholder="Enter your password" required>
                </label>
                <button type="submit" style="width: 100%;">Sign In</button>
              </form>
            </article>
          </div>
        `));
      }

      request.session.set('adminId', admin.id);
      return reply.redirect('/admin/dashboard');
    });

    app.addHook('preHandler', async (request, reply) => {
      // Skip auth for login page and OAuth callback routes
      const publicPaths = [
        '/admin/login',
        '/admin/calendars/callback/google',
        '/admin/calendars/callback/microsoft',
        '/admin/calendars/zoho/callback',
      ];
      const urlPath = request.url.split('?')[0]; // strip query string
      if (publicPaths.includes(urlPath)) return;
      if (!request.session.get('adminId')) {
        return reply.redirect('/admin/login');
      }
    });


    app.get('/dashboard', async (request, reply) => {
      const token = reply.generateCsrf();
      const adminId = request.session.get('adminId');
      const admin = app.db.prepare('SELECT timezone FROM admin WHERE id = ?').get(adminId);
      const adminTz = admin ? admin.timezone : 'UTC';

      const activeProfiles = app.db.prepare("SELECT COUNT(*) as count FROM booking_profiles WHERE is_active = 1").get().count;
      const now = new Date().toISOString();
      const upcomingCount = app.db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'confirmed' AND start_time > ?").get(now).count;
      const next5 = app.db.prepare(
        "SELECT b.*, bp.name as profile_name FROM bookings b JOIN booking_profiles bp ON b.profile_id = bp.id WHERE b.status = 'confirmed' AND b.start_time > ? ORDER BY b.start_time ASC LIMIT 5"
      ).all(now);

      const next5Rows = next5.map(b => {
        const start = new Date(b.start_time);
        const dateStr = start.toLocaleString('en-US', { timeZone: adminTz, dateStyle: 'medium', timeStyle: 'short' });
        return `<tr><td>${escapeHtml(dateStr)}</td><td>${escapeHtml(b.title)}</td><td>${escapeHtml(b.booker_name)}</td><td>${escapeHtml(b.profile_name)}</td></tr>`;
      }).join('');

      reply.type('text/html').send(BASE_LAYOUT('Dashboard', `
        <nav>
          <a href="/admin/dashboard">Dashboard</a>
          <a href="/admin/bookings">Bookings</a>
          <a href="/admin/profiles">Profiles</a>
          <a href="/admin/calendars">Calendars</a>
          <a href="/admin/settings">Settings</a>
        </nav>
        <h1>Dashboard</h1>
        <div class="grid">
          <article>
            <h3>Active Profiles</h3>
            <p><strong>${activeProfiles}</strong></p>
          </article>
          <article>
            <h3>Upcoming Bookings</h3>
            <p><strong>${upcomingCount}</strong></p>
          </article>
        </div>
        ${next5.length ? `
          <div class="card">
            <h2>Next Upcoming Bookings</h2>
            <table>
              <thead><tr><th>Date/Time</th><th>Title</th><th>Booker</th><th>Profile</th></tr></thead>
              <tbody>${next5Rows}</tbody>
            </table>
          </div>
        ` : '<article><p>No upcoming bookings.</p></article>'}
        <form method="POST" action="/admin/logout" style="margin-top: 2rem;">
          <input type="hidden" name="_csrf" value="${token}">
          <button type="submit" class="secondary">Logout</button>
        </form>
      `));
    });

    app.get('/bookings', async (request, reply) => {
      const token = reply.generateCsrf();
      const adminId = request.session.get('adminId');
      const admin = app.db.prepare('SELECT timezone FROM admin WHERE id = ?').get(adminId);
      const adminTz = admin ? admin.timezone : 'UTC';

      const { status, profile_id, page } = request.query;
      const currentPage = parseInt(page, 10) || 1;
      const perPage = 20;
      const offset = (currentPage - 1) * perPage;

      let where = [];
      let params = [];
      if (status && (status === 'confirmed' || status === 'cancelled')) {
        where.push('b.status = ?');
        params.push(status);
      }
      if (profile_id) {
        where.push('b.profile_id = ?');
        params.push(parseInt(profile_id, 10));
      }

      const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
      const now = new Date().toISOString();

      const countResult = app.db.prepare(`SELECT COUNT(*) as count FROM bookings b ${whereClause}`).get(...params);
      const totalPages = Math.ceil(countResult.count / perPage);

      const bookings = app.db.prepare(
        `SELECT b.*, bp.name as profile_name FROM bookings b JOIN booking_profiles bp ON b.profile_id = bp.id ${whereClause} ORDER BY CASE WHEN b.start_time > ? THEN 0 ELSE 1 END, b.start_time ASC LIMIT ? OFFSET ?`
      ).all(...params, now, perPage, offset);

      const profiles = app.db.prepare("SELECT id, name FROM booking_profiles ORDER BY name").all();
      const profileOptions = profiles.map(p =>
        `<option value="${p.id}"${profile_id && parseInt(profile_id) === p.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`
      ).join('');

      const rows = bookings.map(b => {
        const start = new Date(b.start_time);
        const dateStr = start.toLocaleString('en-US', { timeZone: adminTz, dateStyle: 'medium', timeStyle: 'short' });
        const statusBadge = b.status === 'cancelled'
          ? '<span class="badge error">Cancelled</span>'
          : '<span class="badge success">Confirmed</span>';
        const cancelBtn = b.status === 'confirmed'
          ? `<form method="POST" action="/admin/bookings/${b.id}/cancel" style="display:inline"><input type="hidden" name="_csrf" value="${token}"><button type="submit" class="danger">Cancel</button></form>`
          : '';
        return `<tr><td>${escapeHtml(dateStr)}</td><td>${b.duration_minutes} min</td><td>${escapeHtml(b.profile_name)}</td><td>${escapeHtml(b.booker_name)}</td><td>${escapeHtml(b.booker_email)}</td><td>${escapeHtml(b.title)}</td><td>${statusBadge}</td><td class="actions-cell">${cancelBtn}</td></tr>`;

      }).join('');

      const pagination = totalPages > 1 ? `<nav><ul>${Array.from({ length: totalPages }, (_, i) => {
        const p = i + 1;
        const qs = new URLSearchParams();
        if (status) qs.set('status', status);
        if (profile_id) qs.set('profile_id', profile_id);
        qs.set('page', p);
        return `<li><a href="/admin/bookings?${qs}"${p === currentPage ? ' aria-current="page"' : ''}>${p}</a></li>`;
      }).join('')}</ul></nav>` : '';

      reply.type('text/html').send(BASE_LAYOUT('Bookings', `
        <nav>
          <a href="/admin/dashboard">Dashboard</a>
          <a href="/admin/bookings">Bookings</a>
          <a href="/admin/profiles">Profiles</a>
          <a href="/admin/calendars">Calendars</a>
          <a href="/admin/settings">Settings</a>
        </nav>
        <h1>Bookings</h1>
        <div class="card">
          <form method="GET" action="/admin/bookings" role="group">
            <select name="status">
              <option value="">All Statuses</option>
              <option value="confirmed"${status === 'confirmed' ? ' selected' : ''}>Confirmed</option>
              <option value="cancelled"${status === 'cancelled' ? ' selected' : ''}>Cancelled</option>
            </select>
            <select name="profile_id">
              <option value="">All Profiles</option>
              ${profileOptions}
            </select>
            <button type="submit">Filter</button>
          </form>
        </div>
        <table>
          <thead><tr><th>Date/Time</th><th>Duration</th><th>Profile</th><th>Booker</th><th>Email</th><th>Title</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="8" style="text-align:center;color:var(--text-secondary);">No bookings found</td></tr>'}</tbody>
        </table>
        ${pagination}
      `));
    });

    app.post('/bookings/:id/cancel', { preHandler: app.csrfProtection }, async (request, reply) => {
      const { id } = request.params;
      const booking = app.db.prepare("SELECT b.*, bp.write_calendar_id FROM bookings b JOIN booking_profiles bp ON b.profile_id = bp.id WHERE b.id = ?").get(id);

      if (!booking) {
        return reply.code(404).type('text/html').send(BASE_LAYOUT('Not Found', '<h1>Booking not found</h1>'));
      }

      if (booking.status === 'cancelled') {
        return reply.code(400).type('text/html').send(BASE_LAYOUT('Error', '<h1>Booking already cancelled</h1>'));
      }

      if (booking.calendar_event_id) {
        const deleteEv = async (connection, eventId) => {
          try {
            let accessToken;
            try { accessToken = decrypt(connection.encrypted_access_token, encryptionKey); } catch { accessToken = connection.encrypted_access_token; }
            if (connection.provider === 'google') {
              await app.fetchFn(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}?sendUpdates=all`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
            } else if (connection.provider === 'microsoft') {
              await app.fetchFn(`https://graph.microsoft.com/v1.0/me/events/${eventId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
            } else if (connection.provider === 'zoho') {
              const calendarsResponse = await app.fetchFn('https://calendar.zoho.com/api/v1/calendars', { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
              const calendarsData = await calendarsResponse.json();
              const primaryCalendar = calendarsData.calendars.find(c => c.isprimary) || calendarsData.calendars[0];
              await app.fetchFn(`https://calendar.zoho.com/api/v1/calendars/${primaryCalendar.uid}/events/${eventId}`, { method: 'DELETE', headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
            }
          } catch { }
        };

        try {
          const events = JSON.parse(booking.calendar_event_id);
          for (const ev of events) {
            const connection = app.db.prepare("SELECT * FROM calendar_connections WHERE id = ? AND status = 'connected'").get(ev.connectionId);
            if (connection) await deleteEv(connection, ev.eventId);
          }
        } catch (err) {
          if (booking.write_calendar_id) {
            const connection = app.db.prepare("SELECT * FROM calendar_connections WHERE id = ? AND status = 'connected'").get(booking.write_calendar_id);
            if (connection) await deleteEv(connection, booking.calendar_event_id);
          }
        }
      }

      app.db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(id);
      return reply.redirect('/admin/bookings');
    });

    app.post('/logout', { preHandler: app.csrfProtection }, async (request, reply) => {
      await request.session.destroy();
      return reply.redirect('/admin/login');
    });

    app.get('/calendars', async (request, reply) => {
      const connections = app.db.prepare('SELECT * FROM calendar_connections').all();
      const token = reply.generateCsrf();
      const icons = {
        google: `<svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>`,
        microsoft: `<svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M1.15 1.15h10.27v10.27H1.15z" fill="#f25022"/><path d="M12.58 1.15h10.27v10.27H12.58z" fill="#7fba00"/><path d="M1.15 12.58h10.27v10.27H1.15z" fill="#00a4ef"/><path d="M12.58 12.58h10.27v10.27H12.58z" fill="#ffb900"/></svg>`,
        zoho: `<svg width="18" height="18" viewBox="0 0 24 24" fill="#E31A2D" xmlns="http://www.w3.org/2000/svg"><path d="M23.111 21.054a1.862 1.862 0 1 1 0 3.725 1.862 1.862 0 0 1 0-3.725ZM7.587 3.551a3.551 3.551 0 1 1 0 7.102 3.551 3.551 0 0 1 0-7.102Zm7.564 3.726c1.614 0 2.923.637 2.923 1.956v3.744h.79a1.002 1.002 0 0 0 .977-1.196L18.423.856a.992.992 0 0 0-.964-.856H3.344a.99.99 0 0 0-.982 1.13l.872 6.071c.07.494.512.8711 1.012.8711h9.905v.2c0 .548-.567 1.002-1.282 1.002H7.669c-2.316 0-4.195-1.554-4.195-3.473V4.945C3.474 2.213 5.342 0 7.644 0h11.233L20.89 13.999a2.981 2.981 0 0 1-2.909 3.578h-.572a.992.992 0 0 0-.992.993v2.858c0 .548-.574 1.002-1.282 1.002H9.083l-4.526 2.45a2.155 2.155 0 0 1-1.026.257H1.587a.991.991 0 0 1-.991-.991v-2.072c0-1.874 1.83-3.41 4.103-3.41h10.453v.19c0-1.309-1.309-1.946-2.923-1.946h-3.486A5.513 5.513 0 0 1 3.474 11.29V8.657a.992.992 0 0 1 .992-.992h10.685Zm-7.564.846a.735.735 0 1 0 0 1.47.735.735 0 0 0 0-1.47Z"/></svg>`
      };

      const connectionRows = connections.map(c => `
        <tr>
          <td><div style="display:flex;align-items:center;gap:8px;">${icons[c.provider] || ''} ${escapeHtml(c.provider)}</div></td>
          <td>${escapeHtml(c.email || '')}</td>
          <td>${escapeHtml(c.status)}</td>
          <td>
            <form method="POST" action="/admin/calendars/${c.id}/disconnect" style="display:inline">
              <input type="hidden" name="_csrf" value="${token}">
              <button type="submit" class="danger">Disconnect</button>
            </form>
          </td>
        </tr>
      `).join('');

      const googleConfigured = !!(googleClientId && googleClientSecret && googleRedirectUri);
      const msClientId = opts.microsoftClientId || process.env.MICROSOFT_CLIENT_ID;
      const msConfigured = !!msClientId;
      const zohoConfigured = !!(zohoClientId && zohoClientSecret && zohoRedirectUri);

      const connectBtn = (href, label, svg, configured) => configured
        ? `<a href="${href}" role="button" class="outline" style="display:inline-flex;align-items:center;gap:8px;background:var(--neutral-0);">${svg} ${label}</a>`
        : `<a role="button" class="secondary outline" aria-disabled="true" style="pointer-events:none;opacity:0.5;display:inline-flex;align-items:center;gap:8px;background:var(--neutral-0);" title="Not configured">${svg} ${label}</a>`;

      const missingVars = [];
      if (!googleConfigured) missingVars.push('Google (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)');
      if (!msConfigured) missingVars.push('Microsoft (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID, MICROSOFT_REDIRECT_URI)');
      if (!zohoConfigured) missingVars.push('Zoho (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REDIRECT_URI)');
      const configNotice = missingVars.length
        ? `<details><summary>Some providers are not configured</summary><p>Add the following to your <code>.env</code> file:</p><ul>${missingVars.map(v => `<li>${v}</li>`).join('')}</ul></details>`
        : '';

      reply.type('text/html').send(BASE_LAYOUT('Calendar Connections', `
        <nav>
          <a href="/admin/dashboard">Dashboard</a>
          <a href="/admin/bookings">Bookings</a>
          <a href="/admin/profiles">Profiles</a>
          <a href="/admin/calendars">Calendars</a>
          <a href="/admin/settings">Settings</a>
        </nav>
        <h1>Calendar Connections</h1>
        ${configNotice}
        <div class="card" style="display: flex; gap: 1rem; flex-wrap: wrap;">
          ${connectBtn('/admin/calendars/connect/google', 'Connect Google Calendar', icons.google, googleConfigured)}
          ${connectBtn('/admin/calendars/connect/microsoft', 'Connect Office 365 Calendar', icons.microsoft, msConfigured)}
          ${connectBtn('/admin/calendars/connect/zoho', 'Connect Zoho Calendar', icons.zoho, zohoConfigured)}
        </div>
        ${connections.length ? `
          <table>
            <thead><tr><th>Provider</th><th>Email</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${connectionRows}</tbody>
          </table>
        ` : '<article><p>No calendar connections yet. Connect your calendar to get started.</p></article>'}
      `));
    });

    app.get('/calendars/connect/google', async (request, reply) => {
      if (!googleClientId || !googleClientSecret || !googleRedirectUri) {
        return reply.status(400).type('text/html').send(BASE_LAYOUT('Not Configured', `
          <h1>Google OAuth2 Not Configured</h1>
          <p>Add <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, and <code>GOOGLE_REDIRECT_URI</code> to your <code>.env</code> file, then restart the server.</p>
          <a href="/admin/calendars" role="button" class="secondary">Back to Calendars</a>
        `));
      }
      const url = buildGoogleAuthUrl(googleClientId, googleRedirectUri);
      return reply.redirect(url);
    });

    app.get('/calendars/callback/google', async (request, reply) => {
      const { code, error } = request.query;
      if (!code || error) {
        return reply.redirect('/admin/calendars?error=oauth_denied');
      }
      try {
        const tokens = await exchangeCodeForTokens(code, googleClientId, googleClientSecret, googleRedirectUri);
        const email = await getGoogleUserEmail(tokens.access_token);
        const tokenExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

        const encryptedAccess = encrypt(tokens.access_token, encryptionKey);
        const encryptedRefresh = tokens.refresh_token ? encrypt(tokens.refresh_token, encryptionKey) : null;

        app.db.prepare(
          'INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('google', encryptedAccess, encryptedRefresh || '', tokenExpiry, email, 'connected');

        return reply.redirect('/admin/calendars');
      } catch (err) {
        request.log.error(err);
        return reply.redirect('/admin/calendars?error=oauth_failed');
      }
    });

    app.get('/calendars/connect/microsoft', async (request, reply) => {
      const clientId = opts.microsoftClientId || process.env.MICROSOFT_CLIENT_ID;
      const tenantId = opts.microsoftTenantId || process.env.MICROSOFT_TENANT_ID;
      const redirectUri = opts.microsoftRedirectUri || process.env.MICROSOFT_REDIRECT_URI;
      if (!clientId || !tenantId || !redirectUri) {
        return reply.status(400).type('text/html').send(BASE_LAYOUT('Not Configured', `
          <h1>Microsoft OAuth2 Not Configured</h1>
          <p>Add <code>MICROSOFT_CLIENT_ID</code>, <code>MICROSOFT_CLIENT_SECRET</code>, <code>MICROSOFT_TENANT_ID</code>, and <code>MICROSOFT_REDIRECT_URI</code> to your <code>.env</code> file, then restart the server.</p>
          <a href="/admin/calendars" role="button" class="secondary">Back to Calendars</a>
        `));
      }
      const scope = 'offline_access Calendars.ReadWrite User.Read';
      const state = crypto.randomBytes(16).toString('hex');
      request.session.set('oauthState', state);
      const authUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', scope);
      authUrl.searchParams.set('response_mode', 'query');
      authUrl.searchParams.set('state', state);
      return reply.redirect(authUrl.toString());
    });

    app.get('/calendars/callback/microsoft', async (request, reply) => {
      const { code, state } = request.query;
      if (!code) {
        return reply.status(400).send('Missing authorization code');
      }
      const expectedState = request.session.get('oauthState');
      if (!state || state !== expectedState) {
        return reply.status(403).send('Invalid OAuth state');
      }
      request.session.set('oauthState', null);

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

    app.get('/calendars/connect/zoho', async (request, reply) => {
      if (!zohoClientId || !zohoClientSecret || !zohoRedirectUri) {
        return reply.status(400).type('text/html').send(BASE_LAYOUT('Not Configured', `
          <h1>Zoho OAuth2 Not Configured</h1>
          <p>Add <code>ZOHO_CLIENT_ID</code>, <code>ZOHO_CLIENT_SECRET</code>, and <code>ZOHO_REDIRECT_URI</code> to your <code>.env</code> file, then restart the server.</p>
          <a href="/admin/calendars" role="button" class="secondary">Back to Calendars</a>
        `));
      }
      const params = new URLSearchParams({
        client_id: zohoClientId,
        redirect_uri: zohoRedirectUri,
        response_type: 'code',
        scope: 'ZohoCalendar.calendar.ALL,ZohoCalendar.event.ALL,ZohoCalendar.freebusy.READ',
        access_type: 'offline',
        prompt: 'consent',
      });
      return reply.redirect(`https://accounts.zoho.com/oauth/v2/auth?${params}`);
    });

    app.get('/calendars/zoho/callback', async (request, reply) => {
      const { code } = request.query;
      if (!code) {
        return reply.status(400).send('Missing authorization code');
      }

      const fetchFn = app.zohoFetch || globalThis.fetch;

      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: zohoClientId,
        client_secret: zohoClientSecret,
        redirect_uri: zohoRedirectUri,
        code,
      });

      const tokenResponse = await fetchFn(`https://accounts.zoho.com/oauth/v2/token?${tokenParams}`, {
        method: 'POST',
      });

      if (!tokenResponse.ok) {
        return reply.status(502).send('Failed to exchange code for tokens');
      }

      const tokenData = await tokenResponse.json();
      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

      const userResponse = await fetchFn('https://accounts.zoho.com/oauth/user/info', {
        headers: { Authorization: `Zoho-oauthtoken ${tokenData.access_token}` },
      });
      const userData = await userResponse.json();
      const email = userData.Email || '';

      const encryptedAccess = encrypt(tokenData.access_token, encryptionKey);
      const encryptedRefresh = encrypt(tokenData.refresh_token, encryptionKey);

      app.db.prepare(
        'INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('zoho', encryptedAccess, encryptedRefresh, expiresAt, email, 'connected');

      return reply.redirect('/admin/calendars');
    });

    app.post('/calendars/:id/disconnect', { preHandler: app.csrfProtection }, async (request, reply) => {
      const { id } = request.params;
      // Remove legacy references to prevent FOREIGN KEY constraint failures
      app.db.prepare("UPDATE booking_profiles SET write_calendar_id = NULL WHERE write_calendar_id = ?").run(id);
      app.db.prepare('DELETE FROM calendar_connections WHERE id = ?').run(id);
      return reply.redirect('/admin/calendars');
    });

    registerProfileRoutes(app);

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
        <nav>
          <a href="/admin/dashboard">Dashboard</a>
          <a href="/admin/bookings">Bookings</a>
          <a href="/admin/profiles">Profiles</a>
          <a href="/admin/calendars">Calendars</a>
          <a href="/admin/settings">Settings</a>
        </nav>
        <h1>Settings</h1>
        ${flash ? `<div role="alert" class="success">${escapeHtml(flash)}</div>` : ''}
        <div class="card">
          <h2>Timezone</h2>
          <form method="POST" action="/admin/settings/timezone">
            <input type="hidden" name="_csrf" value="${token}">
            <label>
              Select your timezone
              <select name="timezone">${timezoneOptions}</select>
            </label>
            <button type="submit">Save Timezone</button>
          </form>
        </div>
        <div class="card">
          <h2>Change Password</h2>
          <form method="POST" action="/admin/settings/password">
            <input type="hidden" name="_csrf" value="${token}">
            <label>
              Current Password
              <input type="password" name="current_password" placeholder="Enter current password" required>
            </label>
            <label>
              New Password
              <input type="password" name="new_password" placeholder="Enter new password" required>
            </label>
            <label>
              Confirm New Password
              <input type="password" name="confirm_password" placeholder="Confirm new password" required>
            </label>
            <button type="submit">Change Password</button>
          </form>
        </div>
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
    registerBookingRoutes(app, { encryptionKey, baseLayout: BASE_LAYOUT });
  }, { prefix: '/book' });

  app.register(async function publicApi(app) {
    registerRateLimitHook(app);
    registerSlotsApi(app, { encryptionKey });
    registerBookingSubmitApi(app, { encryptionKey });
  }, { prefix: '/api/book' });

  app.register(async function cancelPage(app) {
    registerCancellationPage(app, { encryptionKey, baseLayout: BASE_LAYOUT });
  }, { prefix: '/cancel' });

  app.register(async function cancelApi(app) {
    registerCancellationApi(app, { encryptionKey });
  }, { prefix: '/api/cancel' });

  app.addHook('onClose', () => {
    db.close();
  });

  return app;
}

module.exports = { buildApp, BASE_LAYOUT };
