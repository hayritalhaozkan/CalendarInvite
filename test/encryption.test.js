const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt } = require('../src/encryption');

describe('Token encryption (AES-256-GCM)', () => {
  const key = 'a'.repeat(64); // 32 bytes hex-encoded

  it('encrypts and decrypts a token round-trip', () => {
    const plaintext = 'my-secret-oauth-token-12345';
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    assert.equal(decrypted, plaintext);
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const plaintext = 'same-token';
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    assert.notEqual(a, b);
  });

  it('fails to decrypt with wrong key', () => {
    const plaintext = 'secret';
    const encrypted = encrypt(plaintext, key);
    const wrongKey = 'b'.repeat(64);
    assert.throws(() => decrypt(encrypted, wrongKey));
  });

  it('handles empty string', () => {
    const encrypted = encrypt('', key);
    const decrypted = decrypt(encrypted, key);
    assert.equal(decrypted, '');
  });

  it('handles unicode content', () => {
    const plaintext = 'token-with-émojis-🔑';
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    assert.equal(decrypted, plaintext);
  });
});
