/* ============================================================
   preload —— 渲染进程与主进程之间的安全桥
   ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pomodoroBridge', {
  /** 更新托盘 / 任务栏 / 窗口标题 */
  updateTray(payload) {
    ipcRenderer.send('tray:update', payload || {});
  },

  /** 同步系统主题（light | dark | auto） */
  setTheme(mode) {
    ipcRenderer.send('theme:set', mode);
  },

  setAlwaysOnTop(v) {
    ipcRenderer.send('window:alwaysOnTop', !!v);
  },

  setMinimizeToTray(v) {
    ipcRenderer.send('window:minimizeToTray', !!v);
  },

  notify(title, body) {
    ipcRenderer.send('app:notify', { title, body });
  },

  /** 接收托盘菜单指令：toggle | skip | reset | focus */
  onCommand(fn) {
    ipcRenderer.on('command', (_e, cmd) => fn(cmd));
  },

  info() {
    return ipcRenderer.invoke('app:info');
  },

  isDesktop: true
});
