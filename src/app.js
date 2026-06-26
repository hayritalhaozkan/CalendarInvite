const fastify = require('fastify');
const formbody = require('@fastify/formbody');
const cookie = require('@fastify/cookie');
const session = require('@fastify/session');
const { createDatabase } = require('./db');

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
  app.register(session, {
    secret: opts.sessionSecret || process.env.SESSION_SECRET || 'a'.repeat(32),
    cookie: { secure: false, httpOnly: true, sameSite: 'lax' },
  });

  app.get('/', async (request, reply) => {
    reply.type('text/html').send(BASE_LAYOUT('Home', `
      <h1>CalendarInvite</h1>
      <p>Self-hosted booking tool. Pico CSS powered.</p>
    `));
  });

  app.register(async function adminRoutes(app) {
    app.get('/login', async (request, reply) => {
      reply.type('text/html').send(BASE_LAYOUT('Admin Login', `
        <h1>Admin Login</h1>
        <form method="POST" action="/admin/login">
          <label>Username <input type="text" name="username" required></label>
          <label>Password <input type="password" name="password" required></label>
          <button type="submit">Login</button>
        </form>
      `));
    });
  }, { prefix: '/admin' });

  app.register(async function publicRoutes(app) {
    app.get('/:slug', async (request, reply) => {
      const { slug } = request.params;
      reply.type('text/html').send(BASE_LAYOUT(`Book - ${slug}`, `
        <h1>Book a meeting</h1>
        <p>Booking page for <strong>${slug}</strong></p>
      `));
    });
  }, { prefix: '/book' });

  app.addHook('onClose', () => {
    db.close();
  });

  return app;
}

module.exports = { buildApp };
