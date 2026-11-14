import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
let userDataPath;

const originalLoad = Module._load;
Module._load = function loadWithElectronMock(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => userDataPath },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value, 'utf8'),
        decryptString: (value) => value.toString('utf8'),
      },
      shell: { openExternal: async () => {} },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const apiKeys = require('../main/api-keys');
Module._load = originalLoad;

async function createUserData(t) {
  userDataPath = await fs.mkdtemp(path.join(process.cwd(), 'api-keys-test-'));
  t.after(() => fs.rm(userDataPath, { recursive: true, force: true }));
  return path.join(userDataPath, 'api-keys.json');
}

test('one API key per provider can be saved, replaced, and removed', async (t) => {
  const storageFile = await createUserData(t);
  const legacyKey = `gsk_${'l'.repeat(20)}`;
  const nextKey = `gsk_${'n'.repeat(20)}`;
  await fs.writeFile(storageFile, JSON.stringify({
    groq: Buffer.from(legacyKey, 'utf8').toString('base64'),
  }));

  let status = apiKeys.status();
  assert.equal(status.providers.groq.configured, true);
  assert.equal(status.providers.groq.masked, `gsk_${'•'.repeat(16)}${legacyKey.slice(-4)}`);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(legacyKey));
  assert.equal('keys' in status.providers.groq, false);
  assert.deepEqual(apiKeys.revealKey('groq'), { ok: true, value: legacyKey });
  assert.deepEqual(apiKeys.revealKey('unknown'), { ok: false, error: 'Unknown provider.' });

  assert.deepEqual(apiKeys.setKey('groq', legacyKey), { ok: true, activeChanged: false });
  assert.deepEqual(apiKeys.setKey('groq', nextKey), { ok: true, activeChanged: true });
  assert.equal(apiKeys.getEnv().GROQ_API_KEY, nextKey);
  assert.equal(apiKeys.status().providers.groq.configured, true);
  assert.deepEqual(apiKeys.clearKey('groq'), { ok: true, activeChanged: true });
  assert.deepEqual(apiKeys.clearKey('groq'), { ok: true, activeChanged: false });

  const nvidiaKey = `nvapi-${'v'.repeat(24)}`;
  assert.deepEqual(apiKeys.setKey('nvidia', nvidiaKey), { ok: true, activeChanged: true });
  status = apiKeys.status();
  assert.equal(status.providers.nvidia.configured, true);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(nvidiaKey));
});

test('migration keeps the active key and removes other saved keys', async (t) => {
  const storageFile = await createUserData(t);
  const discardedKey = `gsk_${'d'.repeat(20)}`;
  const activeKey = `gsk_${'a'.repeat(20)}`;
  await fs.writeFile(storageFile, JSON.stringify({
    version: 2,
    providers: {
      groq: {
        activeId: 'keep-me',
        keys: [
          { id: 'discard-me', label: 'Old name', secret: Buffer.from(discardedKey).toString('base64') },
          { id: 'keep-me', label: 'Active name', secret: Buffer.from(activeKey).toString('base64') },
        ],
      },
    },
  }));

  const status = apiKeys.status();
  assert.equal(status.providers.groq.masked, `gsk_${'•'.repeat(16)}${activeKey.slice(-4)}`);
  assert.equal(apiKeys.getEnv().GROQ_API_KEY, activeKey);

  const stored = JSON.parse(await fs.readFile(storageFile, 'utf8'));
  assert.deepEqual(stored.providers.groq.keys.map((key) => key.id), ['keep-me']);
  assert.equal(stored.providers.groq.activeId, 'keep-me');
  assert.equal('label' in stored.providers.groq.keys[0], false);
});
