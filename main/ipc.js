const { app, ipcMain, shell, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { registerApiKeyIpc } = require('./api-keys-ipc');

const winOf = (event) => BrowserWindow.fromWebContents(event.sender);

/*
 * THE history folder. One pinned folder holds the whole agent history -
 * every conversation, its attachments and its AI titles:
 *
 *   <userData>/chats
 *
 * The agent is pointed at exactly this folder (main/ai-server.js passes it as
 * ARTEMIS_DATA_DIR), so what the sidebar loads and what lives on disk is the
 * same place. The renderer can show the path and open the folder, but it can
 * never choose the path: that stays pinned here.
 */
const historyFolder = () => path.join(app.getPath('userData'), 'chats');

function registerWindowIpc() {
  // The folder exists from launch, so "Open folder" always has something to
  // show - even before the first conversation was ever saved.
  fs.mkdirSync(historyFolder(), { recursive: true });

  ipcMain.on('window:minimize', (e) => winOf(e)?.minimize());

  ipcMain.on('window:toggle-maximize', (e) => {
    const win = winOf(e);
    if (!win) return;
    if (win.isFullScreen()) win.setFullScreen(false);
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on('window:close', (e) => winOf(e)?.close());

  ipcMain.handle('window:is-maximized', (e) => {
    const win = winOf(e);
    return win ? win.isMaximized() || win.isFullScreen() : false;
  });

  ipcMain.handle('history:folder', () => ({ path: historyFolder() }));

  // shell.openPath resolves to "" on success, an error message otherwise.
  ipcMain.handle('history:open-folder', async () => {
    const folder = historyFolder();
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (error) {
      console.warn('[History] could not create the history folder:', error?.message || error);
    }
    const error = await shell.openPath(folder);
    if (error) console.warn('[History] could not open the history folder:', error);
    return { ok: !error, path: folder, error: error || null };
  });

  registerApiKeyIpc();
}

module.exports = { registerWindowIpc, historyFolder };
