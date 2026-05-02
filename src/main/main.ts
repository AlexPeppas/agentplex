import { app, BrowserWindow, Menu, nativeImage, session } from 'electron';
import path from 'node:path';
import { sessionManager } from './session-manager';
import { registerIpcHandlers } from './ipc-handlers';
import { detectShells } from './shell-detector';
import { startRemoteServer, stopRemoteServer } from './remote';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// Prevent remote debugging port from being opened (blocks --remote-debugging-port flag)
app.commandLine.appendSwitch('remote-debugging-port', '0');
// Disable exposing the app over any network interface
app.commandLine.appendSwitch('remote-allow-origins', '');

// Handle Squirrel install/update/uninstall events immediately — skip app startup
if (process.platform === 'win32') {
  const cmd = process.argv[1];
  if (cmd === '--squirrel-install' || cmd === '--squirrel-updated' || cmd === '--squirrel-uninstall' || cmd === '--squirrel-obsolete') {
    app.quit();
  }
}

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.stack || err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

function getAppIcon() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath)
    : path.resolve(__dirname, '../../');
  const ext = process.platform === 'win32' ? 'logo.ico' : process.platform === 'darwin' ? 'logo.icns' : 'logo.png';
  const iconPath = path.join(base, 'assets', ext);
  try {
    return nativeImage.createFromPath(iconPath);
  } catch {
    return undefined;
  }
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'AgentPlex',
    icon: getAppIcon(),
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform !== 'darwin' && {
      titleBarOverlay: {
        color: '#1e1c18',
        symbolColor: '#ece4d8',
        height: 48,
      },
    }),
    backgroundColor: '#262420',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Show window as soon as the renderer is ready — avoids white flash
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Build a platform-appropriate application menu.
  // macOS needs App/File/Edit/View/Window for standard Cmd shortcuts.
  // Windows/Linux keeps a minimal Edit menu plus View for fullscreen.
  const template: Electron.MenuItemConstructorOptions[] = [];

  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
    template.push({
      label: 'File',
      submenu: [
        { role: 'close' },
      ],
    });
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      {
        label: 'Zoom In',
        accelerator: 'CmdOrCtrl+=',
        click: (_item, win) => { (win as BrowserWindow)?.webContents.send('app:zoom', 'in'); },
      },
      {
        label: 'Zoom Out',
        accelerator: 'CmdOrCtrl+-',
        click: (_item, win) => { (win as BrowserWindow)?.webContents.send('app:zoom', 'out'); },
      },
      {
        label: 'Reset Zoom',
        accelerator: 'CmdOrCtrl+0',
        click: (_item, win) => { (win as BrowserWindow)?.webContents.send('app:zoom', 'reset'); },
      },
      { type: 'separator' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  if (process.platform === 'darwin') {
    template.push({
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  sessionManager.setWindow(mainWindow);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }
}

app.whenReady().then(() => {
  // Apply strict CSP in production only (Vite dev server needs unsafe-eval for HMR)
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:"
          ],
        },
      });
    });
  }

  // Fire detection early — don't await, so window creation isn't blocked.
  detectShells().catch((err) => console.error('[shell-detector] Detection failed:', err));
  registerIpcHandlers();
  sessionManager.start();

  // Start the remote API server (HTTP + WebSocket) for web/mobile clients
  startRemoteServer().catch((err: any) => {
    console.error('[remote] Failed to start remote server:', err.message);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopRemoteServer();
  sessionManager.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
