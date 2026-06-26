# Encrypt OAuth tokens at rest in SQLite

OAuth2 access and refresh tokens are encrypted with AES-256-GCM before storage in SQLite, using a key from the `TOKEN_ENCRYPTION_KEY` environment variable. The application decrypts on read and handles token refresh transparently.

If the SQLite file is compromised (backup leak, server access), calendar tokens remain unusable without the encryption key. This is a meaningful security layer given that these tokens grant read/write access to the Admin's calendars. The cost is one env var and a thin encrypt/decrypt wrapper — trivial for the protection it provides.
