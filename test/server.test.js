const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { buildApp } = require('../src/app');

describe('Server', () => {
  let app;

  before(async () => {
    app = buildApp({ dbPath: ':memory:', sessionSecret: 'test-secret-that-is-at-least-32-characters-long', encryptionKey: 'a'.repeat(64), googleClientId: 'test-id', googleClientSecret: 'test-secret', googleRedirectUri: 'http://localhost:3000/admin/calendars/callback/google' });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('serves a placeholder page at GET /', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.headers['content-type'].includes('text/html'));
    assert.ok(response.body.includes('Pico'));
    assert.ok(response.body.includes('CalendarInvite'));
  });

  it('registers admin route group', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/login' });
    assert.notEqual(response.statusCode, 404);
  });

  it('registers public booking route group', async () => {
    app.db.prepare("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES (?, ?, ?, ?)").run('test-slug', 'Test', 1, new Date().toISOString());
    const response = await app.inject({ method: 'GET', url: '/book/test-slug' });
    assert.notEqual(response.statusCode, 404);
    app.db.prepare("DELETE FROM booking_profiles WHERE slug = ?").run('test-slug');
  });
});
