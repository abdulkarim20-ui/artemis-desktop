const { contextBridge, ipcRenderer } = require('electron');

// The agent port is chosen in the main process (ARTEMIS_PORT), so the renderer
// must not assume 3000. The token authenticates loopback /api requests; without
// it a sandboxed iframe could read the user's chats. The handler is registered
// before this window loads.
let agentPort = 3000;
let apiToken = '';
try {
  const config = ipcRenderer.sendSync('app:config') || {};
  agentPort = Number(config.agentPort) || 3000;
  apiToken = typeof config.apiToken === 'string' ? config.apiToken : '';
} catch {
  // Keep the default if the main process is not ready.
}
contextBridge.exposeInMainWorld('appConfig', { agentPort, apiToken });

contextBridge.exposeInMainWorld('shell', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange: (cb) => {
    const handler = (_event, value) => cb(value);
    ipcRenderer.on('window:maximized-changed', handler);
    return () => ipcRenderer.removeListener('window:maximized-changed', handler);
  },
});

/*
 * The history folder: where every saved conversation lives on disk. The
 * renderer can show the path and open the folder, but never choose it - the
 * main process owns that (see main/ipc.js).
 */
contextBridge.exposeInMainWorld('historyFolder', {
  get: () => ipcRenderer.invoke('history:folder'),
  open: () => ipcRenderer.invoke('history:open-folder'),
});

/* API key status is masked; full-key access is limited to the explicit Edit action. */
contextBridge.exposeInMainWorld('apiKeys', {
  status: () => ipcRenderer.invoke('keys:status'),
  reveal: (provider) => ipcRenderer.invoke('keys:reveal', provider),
  save: (provider, value) => ipcRenderer.invoke('keys:save', provider, value),
  clear: (provider) => ipcRenderer.invoke('keys:clear', provider),
  openHelp: (provider) => ipcRenderer.invoke('keys:open-help', provider),
});
