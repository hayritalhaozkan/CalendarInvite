const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC'
    );

    CREATE TABLE IF NOT EXISTS calendar_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL CHECK(provider IN ('google', 'microsoft', 'zoho')),
      encrypted_access_token TEXT,
      encrypted_refresh_token TEXT,
      token_expiry TEXT,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected', 'expired'))
    );

    CREATE TABLE IF NOT EXISTS booking_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      write_calendar_id INTEGER REFERENCES calendar_connections(id),
      meeting_link_url TEXT,
      meeting_tool TEXT CHECK(meeting_tool IN ('teams', 'meet')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_read_calendars (
      profile_id INTEGER NOT NULL REFERENCES booking_profiles(id) ON DELETE CASCADE,
      calendar_connection_id INTEGER NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
      PRIMARY KEY (profile_id, calendar_connection_id)
    );

    CREATE TABLE IF NOT EXISTS default_attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES booking_profiles(id) ON DELETE CASCADE,
      email TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES booking_profiles(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES booking_profiles(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      is_blocked INTEGER NOT NULL DEFAULT 0,
      custom_ranges TEXT
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES booking_profiles(id) ON DELETE CASCADE,
      booker_name TEXT NOT NULL,
      booker_email TEXT NOT NULL,
      additional_attendees TEXT,
      title TEXT NOT NULL,
      description TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      cancellation_token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'cancelled')),
      calendar_event_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function createDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}

module.exports = { initializeSchema, createDatabase };
