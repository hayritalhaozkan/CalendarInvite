require('dotenv').config();
const bcrypt = require('bcrypt');
const { createDatabase } = require('../src/db');

const SALT_ROUNDS = 12;

async function seed() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    console.error('ADMIN_USERNAME and ADMIN_PASSWORD environment variables are required');
    process.exit(1);
  }

  const dbPath = process.env.DB_PATH || './data/calendar-invite.db';
  const db = createDatabase(dbPath);

  const existing = db.prepare('SELECT id FROM admin WHERE username = ?').get(username);
  if (existing) {
    console.log(`Admin "${username}" already exists, skipping seed.`);
    db.close();
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run(username, passwordHash, 'UTC');
  console.log(`Admin "${username}" created successfully.`);
  db.close();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
