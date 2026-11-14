/*
 * API key service. Each provider has one saved key. Mutations return
 * { ok, activeChanged } so the caller only restarts the AI agent when the
 * live key actually changed.
 *
 * The full key is returned only through the explicit reveal action.
 */
const { shell } = require('electron');
const store = require('./store');
const { PROVIDERS, clean, mask } = require('./providers');

const PROVIDER_IDS = Object.keys(PROVIDERS);
const fail = (error) => ({ ok: false, error });

const activeOf = (entry) => entry.keys.find((k) => k.id === entry.activeId) || entry.keys[0] || null;

function guard(providerId) {
  if (!PROVIDERS[providerId]) return 'Unknown provider.';
  let available;
  try {
    available = store.encryptionAvailable();
  } catch (error) {
    return error.message;
  }
  if (!available) return 'Secure storage is not available on this system, so the key was not saved.';
  return null;
}

function validateKey(providerId, raw) {
  const provider = PROVIDERS[providerId];
  const key = clean(raw);
  if (!key) return { error: 'Paste a key first.' };
  if (!provider.valid(key)) {
    return { error: `That does not look like a ${provider.label} key (it should start with ${provider.prefix}).` };
  }
  return { key };
}

function status() {
  const available = store.encryptionAvailable();
  const data = store.read(PROVIDER_IDS);
  const providers = {};

  for (const id of PROVIDER_IDS) {
    const entry = data.providers[id] || { keys: [], activeId: null };
    const active = activeOf(entry);
    providers[id] = {
      configured: Boolean(available && active),
      masked: available && active ? mask(store.decrypt(active.secret)) : '',
    };
  }
  return { encryptionAvailable: available, providers };
}

function revealKey(providerId) {
  if (!PROVIDERS[providerId]) return fail('Unknown provider.');
  try {
    if (!store.encryptionAvailable()) {
      return fail('Secure storage is not available on this system.');
    }
    const data = store.read(PROVIDER_IDS);
    const entry = data.providers[providerId];
    const active = entry && activeOf(entry);
    if (!active) return fail('No API key is saved for this provider.');
    return { ok: true, value: store.decrypt(active.secret) };
  } catch (error) {
    return fail(`Could not reveal the saved key: ${error?.message || error}`);
  }
}

function setKey(providerId, raw) {
  const blocked = guard(providerId);
  if (blocked) return fail(blocked);
  const checked = validateKey(providerId, raw);
  if (checked.error) return fail(checked.error);

  try {
    const data = store.read(PROVIDER_IDS);
    const entry = data.providers[providerId] || { activeId: null, keys: [] };
    const active = activeOf(entry);
    if (active && store.decrypt(active.secret) === checked.key) {
      return { ok: true, activeChanged: false };
    }

    const item = active
      ? { ...active, secret: store.encrypt(checked.key) }
      : {
          id: store.newId(),
          secret: store.encrypt(checked.key),
          createdAt: Date.now(),
        };
    data.providers[providerId] = { activeId: item.id, keys: [item] };
    store.write(data);
    return { ok: true, activeChanged: true };
  } catch (error) {
    return fail(`Could not save the key: ${error?.message || error}`);
  }
}

function clearKey(providerId) {
  const blocked = guard(providerId);
  if (blocked) return fail(blocked);
  try {
    const data = store.read(PROVIDER_IDS);
    const entry = data.providers[providerId];
    if (!entry || !activeOf(entry)) return { ok: true, activeChanged: false };
    delete data.providers[providerId];
    store.write(data);
    return { ok: true, activeChanged: true };
  } catch (error) {
    return fail(`Could not remove the key: ${error?.message || error}`);
  }
}

/* Active key per provider, as env vars for the agent process. */
function getEnv() {
  const env = {};
  if (!store.encryptionAvailable()) return env;
  const data = store.read(PROVIDER_IDS);
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    const entry = data.providers[id];
    const active = entry && activeOf(entry);
    if (active) env[provider.env] = store.decrypt(active.secret);
  }
  return env;
}

/* The URL comes from PROVIDERS, never from the renderer. */
async function openHelp(providerId) {
  const url = PROVIDERS[providerId]?.helpUrl;
  if (!url || !url.startsWith('https://')) return fail('Unknown provider.');
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (error) {
    return fail(String(error?.message || error));
  }
}

module.exports = { status, revealKey, setKey, clearKey, getEnv, openHelp };
