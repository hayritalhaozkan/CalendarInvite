const { encrypt, decrypt } = require('./encryption');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const GOOGLE_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all';

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];

function buildGoogleAuthUrl(clientId, redirectUri) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: 'google',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code, clientId, clientSecret, redirectUri) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Token exchange failed: ${err.error || 'unknown'}`);
  }

  return response.json();
}

async function getGoogleUserEmail(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch user info');
  }

  const data = await response.json();
  return data.email;
}

async function refreshAccessToken(db, encryptionKey, connectionId, clientId, clientSecret) {
  const conn = db.prepare('SELECT * FROM calendar_connections WHERE id = ?').get(connectionId);
  if (!conn) throw new Error('Connection not found');

  const refreshToken = decrypt(conn.encrypted_refresh_token, encryptionKey);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }).toString(),
  });

  if (!response.ok) {
    db.prepare('UPDATE calendar_connections SET status = ? WHERE id = ?').run('expired', connectionId);
    throw new Error('Token refresh failed');
  }

  const data = await response.json();
  const newExpiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
  const encryptedAccess = encrypt(data.access_token, encryptionKey);

  db.prepare('UPDATE calendar_connections SET encrypted_access_token = ?, token_expiry = ?, status = ? WHERE id = ?')
    .run(encryptedAccess, newExpiry, 'connected', connectionId);

  return data.access_token;
}

async function getValidAccessToken(db, encryptionKey, connectionId, clientId, clientSecret) {
  const conn = db.prepare('SELECT * FROM calendar_connections WHERE id = ?').get(connectionId);
  if (!conn) throw new Error('Connection not found');

  const expiry = new Date(conn.token_expiry);
  if (expiry <= new Date()) {
    return refreshAccessToken(db, encryptionKey, connectionId, clientId, clientSecret);
  }

  return decrypt(conn.encrypted_access_token, encryptionKey);
}

async function getGoogleBusySlots(db, encryptionKey, connectionId, timeMin, timeMax, clientId, clientSecret) {
  const accessToken = await getValidAccessToken(db, encryptionKey, connectionId, clientId, clientSecret);

  const response = await fetch(GOOGLE_FREEBUSY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      items: [{ id: 'primary' }],
    }),
  });

  if (!response.ok) {
    throw new Error('FreeBusy request failed');
  }

  const data = await response.json();
  return data.calendars.primary.busy;
}

async function createGoogleEvent(db, encryptionKey, connectionId, eventData, clientId, clientSecret) {
  const accessToken = await getValidAccessToken(db, encryptionKey, connectionId, clientId, clientSecret);

  const description = eventData.meetingLink
    ? `${eventData.description || ''}\n\nMeeting link: ${eventData.meetingLink}`.trim()
    : eventData.description || '';

  const event = {
    summary: eventData.title,
    description,
    start: { dateTime: eventData.start },
    end: { dateTime: eventData.end },
    attendees: eventData.attendees.map(email => ({ email })),
  };

  const response = await fetch(GOOGLE_EVENTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    throw new Error('Event creation failed');
  }

  const data = await response.json();
  return data.id;
}

module.exports = {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  getGoogleUserEmail,
  refreshAccessToken,
  getValidAccessToken,
  getGoogleBusySlots,
  createGoogleEvent,
};
