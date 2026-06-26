const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initializeSchema } = require('../src/db');

describe('Database schema', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('creates the admin table', () => {
    const info = db.pragma("table_info('admin')");
    const columns = info.map(col => col.name);
    assert.ok(columns.includes('id'));
    assert.ok(columns.includes('username'));
    assert.ok(columns.includes('password_hash'));
    assert.ok(columns.includes('timezone'));
  });

  it('creates the calendar_connections table', () => {
    const info = db.pragma("table_info('calendar_connections')");
    const columns = info.map(col => col.name);
    assert.ok(columns.includes('id'));
    assert.ok(columns.includes('provider'));
    assert.ok(columns.includes('encrypted_access_token'));
    assert.ok(columns.includes('encrypted_refresh_token'));
    assert.ok(columns.includes('token_expiry'));
    assert.ok(columns.includes('email'));
    assert.ok(columns.includes('status'));
  });

  it('creates the booking_profiles table', () => {
    const info = db.pragma("table_info('booking_profiles')");
    const columns = info.map(col => col.name);
    assert.ok(columns.includes('id'));
    assert.ok(columns.includes('slug'));
    assert.ok(columns.includes('name'));
    assert.ok(columns.includes('is_active'));
    assert.ok(columns.includes('write_calendar_id'));
    assert.ok(columns.includes('meeting_link_url'));
    assert.ok(columns.includes('meeting_tool'));
    assert.ok(columns.includes('created_at'));
  });

  it('creates the profile_read_calendars table', () => {
    const info = db.pragma("table_info('profile_read_calendars')");
    const columns = info.map(col => col.name);
    assert.ok(columns.includes('profile_id'));
    assert.ok(columns.includes('calendar_connection_id'));
  });

  it('creates the default_attendees table', () => {
    const info = db.pragma("table_info('default_attendees')");
    const columns = info.map(col => col.name);
    assert.ok(columns.includes('id'));
    assert.ok(columns.includes('profile_id'));
    assert.ok(columns.includes('email'));
  });

  it('creates the schedule_templates table', () => {
    const info = db.pragma("table_info('schedule_templates')");
    const columns = info.map(col => col.name);
    assert.ok(columns.includes('id'));
    assert.ok(columns.includes('profile_id'));
    assert.ok(columns.includes('day_of_week'));
    assert.ok(columns.includes('start_time'));
    assert.ok(columns.includes('end_time'));
  });

  it('creates the schedule_overrides table', () => {
    const info = db.pragma("table_info('schedule_overrides')");
    const columns = info.map(col => col.name);
    assert.ok(columns.includes('id'));
    assert.ok(columns.includes('profile_id'));
    assert.ok(columns.includes('date'));
    assert.ok(columns.includes('is_blocked'));
    assert.ok(columns.includes('custom_ranges'));
  });

  it('creates the bookings table', () => {
    const info = db.pragma("table_info('bookings')");
    const columns = info.map(col => col.name);
    assert.ok(columns.includes('id'));
    assert.ok(columns.includes('profile_id'));
    assert.ok(columns.includes('booker_name'));
    assert.ok(columns.includes('booker_email'));
    assert.ok(columns.includes('additional_attendees'));
    assert.ok(columns.includes('title'));
    assert.ok(columns.includes('description'));
    assert.ok(columns.includes('start_time'));
    assert.ok(columns.includes('end_time'));
    assert.ok(columns.includes('duration_minutes'));
    assert.ok(columns.includes('cancellation_token'));
    assert.ok(columns.includes('status'));
    assert.ok(columns.includes('calendar_event_id'));
    assert.ok(columns.includes('created_at'));
  });

  it('enforces unique slug on booking_profiles', () => {
    db.exec("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES ('test', 'Test', 1, '2024-01-01')");
    assert.throws(() => {
      db.exec("INSERT INTO booking_profiles (slug, name, is_active, created_at) VALUES ('test', 'Test 2', 1, '2024-01-01')");
    });
  });

  it('enforces unique cancellation_token on bookings', () => {
    db.exec("INSERT INTO booking_profiles (id, slug, name, is_active, created_at) VALUES (1, 'p1', 'P1', 1, '2024-01-01')");
    db.exec("INSERT INTO bookings (profile_id, booker_name, booker_email, title, start_time, end_time, duration_minutes, cancellation_token, status, created_at) VALUES (1, 'A', 'a@b.com', 'T', '2024-01-01T10:00', '2024-01-01T10:30', 30, 'tok1', 'confirmed', '2024-01-01')");
    assert.throws(() => {
      db.exec("INSERT INTO bookings (profile_id, booker_name, booker_email, title, start_time, end_time, duration_minutes, cancellation_token, status, created_at) VALUES (1, 'B', 'b@b.com', 'T2', '2024-01-01T11:00', '2024-01-01T11:30', 30, 'tok1', 'confirmed', '2024-01-01')");
    });
  });
});
