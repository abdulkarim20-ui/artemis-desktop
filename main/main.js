const { app, BrowserWindow } = require('electron');
const path = require('path');
const { createMainWindow } = require('./window');
const { registerWindowIpc } = require('./ipc');
const { startAiAgent, stopAiAgent } = require('./ai-server');

// Give Artemis its own Windows taskbar identity (grouping, pinned icon and
// jump list) instead of inheriting Electron's development identity.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.artemis.app');
}

/*
 * Pin the data folder, BEFORE the app is ready. Chat history lives in
 * <userData>/chats, and Electron derives userData from the app's name: started
 * as `electron .` it is the package.json productName, started as
 * `electron main/main.js` (or by some launchers) it falls back to "Electron".
 * Two folders means two histories, and the one you are not looking at looks
 * like chats that were deleted. "Artemis" is what the installed app uses, so
 * existing chats stay exactly where they are.
 */
app.setPath('userData', path.join(app.getPath('appData'), 'Artemis'));

app.whenReady().then(() => {
  registerWindowIpc();

  createMainWindow();
  startAiAgent().catch((err) => console.error('[AI Agent] failed to start:', err));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => {
  stopAiAgent();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
