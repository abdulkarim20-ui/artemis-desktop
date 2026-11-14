const { BrowserWindow, shell } = require('electron');
const path = require('path');
const { isRendererUrl } = require('./renderer-url');

/* Multi-size Artemis mark generated from assets/brand/app_logo.svg. */
const APP_ICON = path.join(
  __dirname,
  '..',
  'assets',
  'brand',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png'
);

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 880,
    minHeight: 560,
    minimizable: true,
    maximizable: true,
    resizable: true,
    frame: false,              // we draw our own title bar
    backgroundColor: '#0D0C0C',
    icon: APP_ICON,            // window + taskbar icon
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  /*
   * Markdown links use target="_blank". Without this handler Electron would
   * create a child window that inherits the preload script, so a remote page
   * could call window.apiKeys.reveal() in the main process.
   *
   * Only ordinary HTTPS links reach the user's browser; every child window is
   * denied. The app window itself may never leave renderer/index.html.
   */
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:' && target.hostname) {
        shell.openExternal(target.href).catch((error) => {
          console.warn('[Window] Could not open external link:', error?.message || error);
        });
      }
    } catch {
      // Malformed URL: deny it below.
    }
    return { action: 'deny' };
  });

  const preventForeignNavigation = (event, url) => {
    if (!isRendererUrl(url)) event.preventDefault();
  };
  win.webContents.on('will-navigate', preventForeignNavigation);
  win.webContents.on('will-redirect', preventForeignNavigation);

  const ses = win.webContents.session;
  const requestsAudioOnly = (details) => {
    const mediaTypes = details?.mediaTypes;
    return Array.isArray(mediaTypes) && mediaTypes.includes('audio') && !mediaTypes.includes('video');
  };
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(webContents === win.webContents && permission === 'media' && requestsAudioOnly(details));
  });
  ses.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    webContents === win.webContents
    && permission === 'media'
    && (!details?.mediaTypes || requestsAudioOnly(details))
  );

  const sendState = () => {
    if (win.isDestroyed()) return;
    win.webContents.send('window:maximized-changed', win.isMaximized() || win.isFullScreen());
  };
  ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']
    .forEach((ev) => win.on(ev, sendState));
  win.webContents.on('did-finish-load', sendState);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

module.exports = { createMainWindow };
