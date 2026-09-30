/* ============================================================
   Electron 主进程 —— Windows 桌面端
   托盘倒计时 / 任务栏进度 / 最小化到托盘 / 原生通知
   ============================================================ */
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, Notification, shell } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'icons');

let win = null;
let tray = null;
let quitting = false;
let minimizeToTray = true;
let trayState = {
  text: '25:00',
  phase: '专注',
  running: false,
  progress: 0,
  title: '番茄钟 · Pomodoro',
  showCountdown: true
};

/* ---------------- 单实例 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    }
  });
}

if (process.platform === 'win32') app.setAppUserModelId('com.pomodoro.desktop');

/* ---------------- 窗口 ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 420,
    minHeight: 620,
    show: false,
    backgroundColor: '#FAF8F5',
    autoHideMenuBar: true,
    title: '番茄钟 · Pomodoro',
    icon: path.join(ICON_DIR, 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.loadFile(path.join(ROOT, 'index.html'));

  win.once('ready-to-show', () => win.show());

  win.on('close', (e) => {
    if (!quitting && minimizeToTray) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => { win = null; });

  // 外链用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ---------------- 托盘 ---------------- */
function trayIcon() {
  const file = process.platform === 'win32'
    ? path.join(ICON_DIR, 'tray-32.png')
    : path.join(ICON_DIR, 'tray-64.png');
  const img = nativeImage.createFromPath(file);
  if (process.platform === 'darwin') img.setTemplateImage(false);
  return img;
}

function trayTooltip() {
  if (!trayState.showCountdown) return '番茄钟';
  return `番茄钟 · ${trayState.phase} ${trayState.text}` + (trayState.running ? '（进行中）' : '（已暂停）');
}

function refreshTray() {
  if (!tray) return;
  try {
    tray.setToolTip(trayTooltip());
    if (process.platform === 'darwin') {
      tray.setTitle(trayState.showCountdown ? trayState.text : '');
    }
    if (win && process.platform === 'win32') {
      win.setProgressBar(trayState.running ? Math.max(0.01, Math.min(1, trayState.progress)) : -1);
    }
    if (win) win.setTitle(trayState.title || '番茄钟 · Pomodoro');
  } catch (e) {
    /* noop */
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: `${trayState.phase} ${trayState.text}`, enabled: false },
    { type: 'separator' },
    {
      label: trayState.running ? '暂停' : '开始 / 继续',
      click: () => sendCommand('toggle')
    },
    { label: '跳过当前阶段', click: () => sendCommand('skip') },
    { label: '重置当前阶段', click: () => sendCommand('reset') },
    { type: 'separator' },
    { label: '显示主窗口', click: () => showWindow() },
    { label: '专注模式', click: () => { showWindow(); sendCommand('focus'); } },
    { type: 'separator' },
    { label: '退出番茄钟', click: () => { quitting = true; app.quit(); } }
  ]);
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
  } catch (e) {
    console.warn('[tray] 创建失败', e);
    return;
  }
  refreshTray();
  tray.on('click', () => showWindow());
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
  tray.on('double-click', () => showWindow());
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function sendCommand(cmd) {
  if (win && win.webContents) win.webContents.send('command', cmd);
}

/* ---------------- IPC ---------------- */
ipcMain.on('tray:update', (_e, payload) => {
  trayState = Object.assign(trayState, payload || {});
  refreshTray();
});

ipcMain.on('theme:set', (_e, mode) => {
  nativeTheme.themeSource = mode === 'dark' ? 'dark' : (mode === 'light' ? 'light' : 'system');
});

ipcMain.on('window:alwaysOnTop', (_e, v) => {
  if (win) win.setAlwaysOnTop(!!v);
});

ipcMain.on('window:minimizeToTray', (_e, v) => {
  minimizeToTray = !!v;
});

ipcMain.on('app:notify', (_e, { title, body }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: title || '番茄钟',
    body: body || '',
    icon: path.join(ICON_DIR, 'icon-192.png'),
    silent: true,
    timeoutType: 'default'
  });
  n.on('click', () => showWindow());
  n.show();
});

ipcMain.handle('app:info', () => ({
  platform: process.platform,
  version: app.getVersion(),
  electron: process.versions.electron
}));

/* ---------------- 生命周期 ---------------- */
app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  // Windows 上驻留托盘，不退出
  if (process.platform !== 'darwin' && quitting) app.quit();
});
