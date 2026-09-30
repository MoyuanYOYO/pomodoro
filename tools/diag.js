/* 快速诊断：加载页面，抓取全部控制台错误与异常堆栈 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME_CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ],
  linux: [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'
  ]
};

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const list = CHROME_CANDIDATES[process.platform] || [];
  for (const p of list) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome / Edge，请用环境变量 CHROME_PATH 指定可执行文件路径');
}

const CHROME = findBrowser();
const TARGET_URL = process.env.POMODORO_URL || 'http://127.0.0.1:5173/index.html';
const PORT = 9334;
const OUT = path.join(__dirname, '..', '.shots');
const USER_DIR = path.join(OUT, '.chrome-diag');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DIR}`,
    '--window-size=1280,900', 'about:blank'
  ], { stdio: 'ignore' });

  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (e) {}
      await sleep(300);
    }
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

    const findings = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        findings.push('EXCEPTION @ ' + (d.url || '?') + ':' + (d.lineNumber + 1) + '\n' +
          (d.exception && d.exception.description ? d.exception.description : d.text));
      }
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        findings.push(m.params.type.toUpperCase() + ': ' +
          m.params.args.map((a) => a.description || JSON.stringify(a.value)).join(' '));
      }
      if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
        findings.push('LOG.' + m.params.entry.level + ': ' + m.params.entry.text + ' @ ' + m.params.entry.url);
      }
    });

    let id = 0;
    const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params: params || {} }));

    send('Runtime.enable');
    send('Log.enable');
    send('Page.enable');
    send('Page.navigate', { url: TARGET_URL });
    await sleep(2500);

    // 触发用户手势路径
    ws.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: {
      expression: `document.getElementById('btnStart').click(); document.getElementById('btnAddTask').click();
        document.getElementById('btnCloseTaskModal').click(); document.getElementById('btnSettings').click(); 1`,
      returnByValue: true
    }}));
    await sleep(2000);

    console.log('=== 发现 ' + findings.length + ' 条 ===');
    findings.forEach((f) => console.log('\n' + f));
    if (!findings.length) console.log('（无异常）');
  } finally {
    chrome.kill();
    await sleep(400);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (e) {}
  }
})();
