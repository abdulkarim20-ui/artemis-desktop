/*
 * Encrypted on-disk storage. Knows nothing about validation rules.
 *
 * File format (v2):
 *   { version: 2, providers: { groq: { activeId, keys: [{ id, secret, createdAt }] } } }
 * `secret` is safeStorage-encrypted, base64.
 *
 * v1 (one base64 string per provider) is migrated on read.
 */
const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE = 'api-keys.json';
const filePath = () => path.join(app.getPath('userData'), FILE);

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (error) {
    throw new Error(`Could not check secure storage: ${error?.message || error}`);
  }
}

const newId = () => crypto.randomBytes(6).toString('hex');

function migrate(parsed, providerIds) {
  if (parsed.version === 2 && parsed.providers && typeof parsed.providers === 'object') {
    const providers = { ...parsed.providers };
    let changed = false;
    for (const id of providerIds) {
      const entry = providers[id];
      if (!entry || !Array.isArray(entry.keys) || entry.keys.length === 0) continue;
      const active = entry.keys.find((key) => key.id === entry.activeId) || entry.keys[0];
      const kept = active ? { ...active } : null;
      let normalize = entry.keys.length > 1;
      if (kept && Object.hasOwn(kept, 'label')) {
        delete kept.label;
        normalize = true;
      }
      if (!normalize) continue;
      providers[id] = {
        ...entry,
        activeId: kept?.id || null,
        keys: kept ? [kept] : [],
      };
      changed = true;
    }
    return changed ? { ...parsed, providers } : parsed;
  }
  const providers = {};
  for (const id of providerIds) {
    const legacy = parsed[id];
    if (typeof legacy === 'string' && legacy) {
      const keyId = newId();
      providers[id] = {
        activeId: keyId,
        keys: [{ id: keyId, secret: legacy, createdAt: Date.now() }],
      };
    }
  }
  return { version: 2, providers };
}

function read(providerIds) {
  let contents;
  try {
    contents = fs.readFileSync(filePath(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 2, providers: {} };
    throw new Error(`Could not read saved API keys: ${error?.message || error}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Saved API key storage is invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Saved API key storage has an invalid format.');
  }
  const data = migrate(parsed, providerIds);
  if (data !== parsed) write(data);
  return data;
}

function write(data) {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

const encrypt = (plain) => safeStorage.encryptString(plain).toString('base64');

function decrypt(secret) {
  try {
    return safeStorage.decryptString(Buffer.from(secret, 'base64')).trim();
  } catch (error) {
    throw new Error(`Could not decrypt a saved key: ${error?.message || error}`);
  }
}

module.exports = { encryptionAvailable, read, write, encrypt, decrypt, newId };
