/*
 * IPC for API keys. Called from registerWindowIpc() in main/ipc.js.
 * Restarts the AI agent only when the live key actually changed.
 */
const { ipcMain } = require('electron');
const apiKeys = require('./api-keys');
const { restartAiAgent } = require('./ai-server');
const { isTrustedIpcSender } = require('./renderer-url');

const safeStatus = () => {
  try {
    return { status: apiKeys.status(), statusError: '' };
  } catch (error) {
    console.error('[API Keys] Could not read saved key status:', error);
    return { status: null, statusError: `Could not read the saved key status: ${error?.message || error}` };
  }
};

async function finish(result) {
  if (!result.ok) return { ok: false, error: result.error, ...safeStatus() };

  let active = true;
  let error = '';
  if (result.activeChanged) {
    try {
      await restartAiAgent();
    } catch (restartError) {
      active = false;
      error = `The key was saved, but the AI agent could not restart: ${restartError?.message || restartError}`;
      console.error('[API Keys] Agent restart failed:', restartError);
    }
  }

  const { status, statusError } = safeStatus();
  return {
    ok: true,
    restarted: Boolean(result.activeChanged),
    active,
    error: [error, statusError].filter(Boolean).join(' ') || undefined,
    status,
  };
}

const denied = () => ({ ok: false, error: 'Unauthorized IPC sender.' });

/*
 * Even with child windows denied, check the caller on every privileged channel:
 * a compromised renderer, an iframe or a future window must not be able to
 * reveal a saved key just because it can reach ipcRenderer.invoke().
 */
function trusted(channel, handler) {
  return (event, ...args) => {
    if (!isTrustedIpcSender(event)) {
      console.warn(`[API Keys] Rejected ${channel} from an untrusted frame.`);
      return denied();
    }
    return handler(...args);
  };
}

function registerApiKeyIpc() {
  ipcMain.handle('keys:status', trusted('keys:status', () => apiKeys.status()));
  ipcMain.handle('keys:reveal', trusted('keys:reveal', (provider) => apiKeys.revealKey(String(provider))));
  ipcMain.handle('keys:save', trusted('keys:save', (provider, value) => finish(apiKeys.setKey(String(provider), value))));
  ipcMain.handle('keys:clear', trusted('keys:clear', (provider) => finish(apiKeys.clearKey(String(provider)))));
  ipcMain.handle('keys:open-help', trusted('keys:open-help', (provider) => apiKeys.openHelp(String(provider))));
}

module.exports = { registerApiKeyIpc };
