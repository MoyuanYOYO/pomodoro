/* ============================================================
   基于 Chrome DevTools Protocol 的场景截图工具（零依赖）
   用法： node tools/shoot.js
   前置： 本地静态服务已在 127.0.0.1:5173 运行
   ============================================================ */
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
const BASE = process.env.POMODORO_URL || 'http://127.0.0.1:5173/index.html';
const PORT = 9333;
const OUT = path.join(__dirname, '..', '.shots');
const USER_DIR = path.join(OUT, '.chrome-profile');

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) { /* retry */ }
    await sleep(300);
  }
  throw new Error('DevTools 端口未就绪');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(method + ' 超时'));
        }
      }, 30000);
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(function(){ ${expr} })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + JSON.stringify(r.result));
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  \u2192 ' + name + '.png');
  }
  async viewport(width, height, scale) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: scale || 2, mobile: false
    });
  }
  async reload() {
    await this.send('Page.reload', { ignoreCache: false });
    await sleep(1400);
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return new CDP(ws);
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`,
    '--window-size=1280,900',
    'about:blank'
  ], { stdio: 'ignore' });

  let failed = 0;
  try {
    await waitForDevtools();

    // 打开页面
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    let page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到 page target');
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    // 每次导航前注入错误收集器，拿到完整堆栈
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__errs = [];
        window.addEventListener('error', function (e) {
          window.__errs.push('error: ' + e.message + ' @ ' + (e.filename||'') + ':' + (e.lineno||''));
        });
        window.addEventListener('unhandledrejection', function (e) {
          var r = e.reason;
          window.__errs.push('rejection: ' + ((r && (r.stack || r.message)) || String(r)));
        });
        var _ce = console.error;
        console.error = function () {
          window.__errs.push('console.error: ' + Array.prototype.map.call(arguments, String).join(' '));
          return _ce.apply(console, arguments);
        };
      `
    });

    // 收集控制台错误
    const consoleErrors = [];
    cdp.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        consoleErrors.push('LOG: ' + m.params.entry.text);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        const detail = (d.exception && (d.exception.description || d.exception.value)) || d.text || '';
        consoleErrors.push('EXCEPTION: ' + detail.split('\n').slice(0, 8).join(' | '));
      }
    });

    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2200);

    console.log('\n场景 1：浅色 · 空白状态');
    await cdp.evaluate(`
      localStorage.clear();
      localStorage.setItem('pomodoro.state.v1', JSON.stringify({ settings: { theme: 'light' } }));
    `);
    await cdp.viewport(1280, 900, 2);
    await cdp.reload();
    await cdp.shot('01-light-empty');

    console.log('\n场景 2：深色 · 空白状态');
    await cdp.evaluate(`
      var raw = JSON.parse(localStorage.getItem('pomodoro.state.v1') || '{}');
      raw.settings = Object.assign(raw.settings || {}, { theme: 'dark' });
      localStorage.setItem('pomodoro.state.v1', JSON.stringify(raw));
    `);
    await cdp.reload();
    await cdp.shot('02-dark-empty');

    console.log('\n场景 3：浅色 · 计时进行中 + 任务列表');
    await cdp.evaluate(`
      var s = Store.state;
      s.settings.theme = 'light';
      s.tasks = [];
      var names = ['写季度复盘', '修复登录超时', '读《深度工作》', '整理需求文档'];
      var tags = ['工作', '开发', '学习', '工作'];
      names.forEach(function(n, i){
        var t = Store.findOrCreateTaskByName(n);
        t.tag = tags[i];
        t.createdAt = Date.now() - i * 1000;
        t.pomodoros = [3,2,1,0][i];
        t.estimate = [4,3,2,1][i];
      });
      s.tasks[0].subs = [
        {id:'s1', name:'汇总数据', done:true},
        {id:'s2', name:'写结论', done:false}
      ];
      s.currentTaskId = s.tasks[0].id;
      s.timer.phase = 'focus';
      s.timer.cycleCount = 2;
      s.timer.remaining = 1147;
      s.timer.sessionPlanned = 1500;
      s.timer.sessionStartedAt = Date.now() - 353000;
      s.timer.running = true;
      s.timer.endAt = Date.now() + 1147000;
      var now = Date.now();
      for (var d = 0; d < 30; d++) {
        var cnt = [3,5,2,6,4,1,7][d % 7];
        for (var i = 0; i < cnt; i++) {
          s.records.push({
            id: 'r'+d+'_'+i, type:'focus', taskId:null,
            taskName: names[i % 4], tag: tags[i % 4],
            start: now - d*86400000 + (9+i)*3600000,
            end: now - d*86400000 + (9+i)*3600000 + 1500000,
            seconds: 1500, completed: true, reason:'', note:''
          });
        }
      }
      s.records.push({id:'x1', type:'focus', taskId:null, taskName:'写季度复盘', tag:'工作',
        start: now - 7200000, end: now - 6300000, seconds: 900, completed:false,
        reason:'外部打断', note:'临时会议'});
      s.records.push({id:'x2', type:'focus', taskId:null, taskName:'整理需求文档', tag:'工作',
        start: now - 5400000, end: now - 5220000, seconds: 300, completed:false,
        reason:'内部干扰', note:''});
      Store.saveNow();
    `);
    await cdp.reload();
    await sleep(600);
    await cdp.shot('03-light-running');

    console.log('\n场景 4：统计视图');
    await cdp.evaluate(`document.querySelector('.nav-item[data-view="stats"]').click();`);
    await sleep(700);
    await cdp.shot('04-light-stats');

    console.log('\n场景 5：设置抽屉');
    await cdp.evaluate(`
      document.querySelector('.nav-item[data-view="timer"]').click();
      document.getElementById('btnSettings').click();
    `);
    await sleep(700);
    await cdp.shot('05-light-settings');

    console.log('\n场景 6：深色 · 计时进行中');
    await cdp.evaluate(`
      document.getElementById('btnCloseSettings').click();
      var s = Store.state;
      s.settings.theme = 'dark';
      s.timer.remaining = 420;
      s.timer.running = true;
      s.timer.endAt = Date.now() + 420000;
      Store.saveNow();
    `);
    await cdp.reload();
    await sleep(600);
    await cdp.shot('06-dark-running');

    console.log('\n场景 7：深色 · 统计视图');
    await cdp.evaluate(`document.querySelector('.nav-item[data-view="stats"]').click();`);
    await sleep(700);
    await cdp.shot('07-dark-stats');

    console.log('\n场景 8：深色 · 设置抽屉');
    await cdp.evaluate(`
      document.querySelector('.nav-item[data-view="timer"]').click();
      document.getElementById('btnSettings').click();
    `);
    await sleep(700);
    await cdp.shot('08-dark-settings');

    console.log('\n场景 9：深色 · 任务编辑弹窗');
    await cdp.evaluate(`
      document.getElementById('btnCloseSettings').click();
      document.getElementById('btnAddTask').click();
    `);
    await sleep(600);
    await cdp.shot('09-dark-task-modal');

    console.log('\n场景 10：深色 · 专注模式');
    await cdp.evaluate(`
      document.getElementById('btnCloseTaskModal').click();
      document.getElementById('btnFocusMode').click();
    `);
    await sleep(700);
    await cdp.shot('10-dark-focus-mode');

    console.log('\n场景 11：手机竖屏（Android）');
    await cdp.evaluate(`
      document.getElementById('btnFocusMode').click();
      var s = Store.state;
      s.settings.theme = 'light';
      Store.saveNow();
    `);
    await cdp.viewport(390, 844, 3);
    await cdp.reload();
    await sleep(700);
    await cdp.shot('11-mobile-timer');

    console.log('\n场景 12：手机竖屏 · 统计');
    await cdp.evaluate(`document.querySelector('.nav-item[data-view="stats"]').click();`);
    await sleep(700);
    await cdp.shot('12-mobile-stats');

    console.log('\n场景 13：手机竖屏 · 设置');
    await cdp.evaluate(`
      document.querySelector('.nav-item[data-view="timer"]').click();
      document.getElementById('btnSettings').click();
    `);
    await sleep(700);
    await cdp.shot('13-mobile-settings');

    // 控制台错误汇总
    const inPageErrs = await cdp.evaluate(`return JSON.stringify(window.__errs || [])`);
    const parsed = JSON.parse(inPageErrs);
    const realErrors = parsed.filter((e) =>
      !/favicon|ServiceWorker|sw\.js|Manifest/i.test(e));
    console.log('\n页面内捕获的错误：' + (realErrors.length ? '' : '无'));
    realErrors.slice(0, 12).forEach((e) => { failed++; console.log('  \u2717 ' + e); });
    console.log('（被过滤的环境噪音 ' + (parsed.length - realErrors.length) + ' 条）');

    // 运行时自检
    const health = await cdp.evaluate(`
      return JSON.stringify({
        store: typeof Store !== 'undefined',
        timer: typeof Timer !== 'undefined',
        sound: typeof Sound !== 'undefined',
        stats: typeof Stats !== 'undefined',
        ringDash: document.getElementById('ringProgress').style.strokeDashoffset,
        timeText: document.getElementById('timeDisplay').textContent,
        cycleDots: document.querySelectorAll('.cycle-dot').length,
        taskItems: document.querySelectorAll('.task-item').length,
        overlayHidden: document.getElementById('focusOverlay').hidden,
        scrimHidden: document.getElementById('scrim').hidden,
        todayCount: document.getElementById('todayCount').textContent,
        bg: getComputedStyle(document.body).backgroundColor,
        fontFamily: getComputedStyle(document.body).fontFamily.slice(0, 40),
        timeFontSize: getComputedStyle(document.getElementById('timeDisplay')).fontSize,
        cardRadius: getComputedStyle(document.querySelector('.timer-card')).borderRadius,
        cardShadow: getComputedStyle(document.querySelector('.timer-card')).boxShadow,
        cardW: Math.round(document.querySelector('.timer-card').getBoundingClientRect().width),
        stripW: Math.round(document.querySelector('.today-strip').getBoundingClientRect().width),
        ringTrackVisible: getComputedStyle(document.querySelector('.ring-track')).stroke
      });
    `);
    const h = JSON.parse(health);
    console.log('\n运行时自检：');
    Object.keys(h).forEach((k) => console.log('  ' + k + ' = ' + h[k]));

  } catch (e) {
    failed++;
    console.error('\n\u2717 截图流程失败：' + e.message);
  } finally {
    chrome.kill();
    await sleep(400);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (e) { /* noop */ }
  }

  console.log('\n结果：' + (failed ? failed + ' 个问题' : '全部通过'));
  process.exit(failed ? 1 : 0);
}

main();
