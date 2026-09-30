/* ============================================================
   store.js — 状态、本地持久化、日期工具
   ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'pomodoro.state.v1';
  var VERSION = 1;

  var DEFAULT_SETTINGS = {
    focus: 25,
    short: 5,
    long: 15,
    longEvery: 4,
    autoStartBreak: true,
    autoStartFocus: false,
    soundOn: true,
    soundVolume: 0.7,
    tickSound: false,
    notify: true,
    theme: 'auto',
    dailyGoal: 8,
    ambient: 'none',
    ambientVolume: 0.35,
    ambientPlaying: false,
    minimizeToTray: true,
    alwaysOnTop: false,
    showTrayCountdown: true
  };

  function defaultState() {
    return {
      version: VERSION,
      settings: Object.assign({}, DEFAULT_SETTINGS),
      timer: {
        phase: 'focus',
        remaining: DEFAULT_SETTINGS.focus * 60,
        running: false,
        endAt: null,
        cycleCount: 0,
        sessionStartedAt: null,
        sessionPlanned: DEFAULT_SETTINGS.focus * 60
      },
      tasks: [],
      currentTaskId: null,
      records: [],
      createdAt: Date.now()
    };
  }

  /* ---------------- 日期工具 ---------------- */

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function dayKey(ts) {
    var d = ts instanceof Date ? ts : new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function startOfDay(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function startOfWeek(ts) {
    var d = new Date(startOfDay(ts));
    var wd = (d.getDay() + 6) % 7; // 周一为一周起点
    d.setDate(d.getDate() - wd);
    return d.getTime();
  }

  function startOfMonth(ts) {
    var d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }

  function addDays(ts, n) {
    var d = new Date(ts);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  function fmtClock(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return pad(m) + ':' + pad(s);
  }

  function fmtTimeHM(ts) {
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtDuration(min) {
    min = Math.round(min);
    if (min < 60) return min + ' 分';
    var h = Math.floor(min / 60);
    var m = min % 60;
    return m ? h + ' 小时 ' + m + ' 分' : h + ' 小时';
  }

  var uidCounter = 0;
  function uid(prefix) {
    uidCounter++;
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + uidCounter.toString(36);
  }

  /* ---------------- 状态 ---------------- */

  var state = defaultState();
  var listeners = [];
  var saveTimer = null;

  function deepMerge(target, patch) {
    if (!patch || typeof patch !== 'object') return target;
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
        deepMerge(target[k], v);
      } else if (v !== undefined) {
        target[k] = v;
      }
    });
    return target;
  }

  function migrate(raw) {
    var base = defaultState();
    if (!raw || typeof raw !== 'object') return base;
    deepMerge(base, {
      settings: raw.settings || {},
      timer: raw.timer || {},
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
      currentTaskId: raw.currentTaskId || null,
      records: Array.isArray(raw.records) ? raw.records : [],
      createdAt: raw.createdAt || Date.now()
    });
    base.version = VERSION;
    // 归一化任务结构
    base.tasks = base.tasks.map(function (t) {
      return {
        id: t.id || uid('task'),
        name: String(t.name || '未命名任务'),
        tag: t.tag || '',
        estimate: Math.max(1, parseInt(t.estimate, 10) || 1),
        done: !!t.done,
        pomodoros: Math.max(0, parseInt(t.pomodoros, 10) || 0),
        focusSeconds: Math.max(0, parseInt(t.focusSeconds, 10) || 0),
        createdAt: t.createdAt || Date.now(),
        subs: Array.isArray(t.subs) ? t.subs.map(function (s) {
          return { id: s.id || uid('sub'), name: String(s.name || ''), done: !!s.done };
        }) : []
      };
    });
    // 归一化记录
    base.records = base.records.filter(function (r) { return r && typeof r === 'object'; }).map(function (r) {
      return {
        id: r.id || uid('rec'),
        type: r.type || 'focus',
        taskId: r.taskId || null,
        taskName: r.taskName || '',
        tag: r.tag || '',
        start: r.start || Date.now(),
        end: r.end || r.start || Date.now(),
        seconds: Math.max(0, parseInt(r.seconds, 10) || 0),
        completed: r.completed !== false,
        reason: r.reason || '',
        note: r.note || ''
      };
    });
    return base;
  }

  function load() {
    var raw = null;
    try {
      var s = global.localStorage.getItem(KEY);
      if (s) raw = JSON.parse(s);
    } catch (e) {
      console.warn('[store] 读取本地数据失败', e);
    }
    state = migrate(raw);
    // 若上次关闭时正在运行，恢复计时
    var t = state.timer;
    if (t.running && t.endAt) {
      if (t.endAt <= Date.now()) {
        t.running = false;
        t.endAt = null;
        t.remaining = 0;
      }
    } else {
      t.running = false;
      t.endAt = null;
    }
    return state;
  }

  function saveNow() {
    try {
      global.localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('[store] 保存失败', e);
    }
  }

  function save() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveNow();
    }, 250);
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (f) { return f !== fn; });
    };
  }

  function emit() {
    listeners.forEach(function (fn) { try { fn(state); } catch (e) { console.error(e); } });
  }

  function set(patch, silent) {
    deepMerge(state, patch);
    save();
    if (!silent) emit();
  }

  function reset() {
    state = defaultState();
    saveNow();
    emit();
  }

  /* ---------------- 任务辅助 ---------------- */

  function getTask(id) {
    if (!id) return null;
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) return state.tasks[i];
    }
    return null;
  }

  function currentTask() {
    return getTask(state.currentTaskId);
  }

  function findOrCreateTaskByName(name, tag) {
    name = String(name || '').trim();
    if (!name) return null;
    var lower = name.toLowerCase();
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].name.toLowerCase() === lower) return state.tasks[i];
    }
    var task = {
      id: uid('task'),
      name: name,
      tag: tag || '',
      estimate: 1,
      done: false,
      pomodoros: 0,
      focusSeconds: 0,
      createdAt: Date.now(),
      subs: []
    };
    state.tasks.unshift(task);
    return task;
  }

  function allTags() {
    var set = {};
    state.tasks.forEach(function (t) { if (t.tag) set[t.tag] = 1; });
    state.records.forEach(function (r) { if (r.tag) set[r.tag] = 1; });
    return Object.keys(set).sort();
  }

  /* ---------------- 记录辅助 ---------------- */

  function addRecord(rec) {
    rec.id = rec.id || uid('rec');
    state.records.push(rec);
    // 只保留最近 5000 条
    if (state.records.length > 5000) state.records.splice(0, state.records.length - 5000);
    save();
  }

  function focusRecords() {
    return state.records.filter(function (r) { return r.type === 'focus'; });
  }

  function countToday() {
    var key = dayKey(Date.now());
    return focusRecords().filter(function (r) {
      return r.completed && dayKey(r.start) === key;
    }).length;
  }

  function focusSecondsToday() {
    var key = dayKey(Date.now());
    return focusRecords().filter(function (r) {
      return r.completed && dayKey(r.start) === key;
    }).reduce(function (a, r) { return a + r.seconds; }, 0);
  }

  function storageSize() {
    try {
      var s = global.localStorage.getItem(KEY) || '';
      return s.length;
    } catch (e) { return 0; }
  }

  global.Store = {
    KEY: KEY,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    get state() { return state; },
    load: load,
    save: save,
    saveNow: saveNow,
    set: set,
    reset: reset,
    subscribe: subscribe,
    emit: emit,
    getTask: getTask,
    currentTask: currentTask,
    findOrCreateTaskByName: findOrCreateTaskByName,
    allTags: allTags,
    addRecord: addRecord,
    focusRecords: focusRecords,
    countToday: countToday,
    focusSecondsToday: focusSecondsToday,
    storageSize: storageSize,
    dayKey: dayKey,
    startOfDay: startOfDay,
    startOfWeek: startOfWeek,
    startOfMonth: startOfMonth,
    addDays: addDays,
    fmtClock: fmtClock,
    fmtTimeHM: fmtTimeHM,
    fmtDuration: fmtDuration,
    uid: uid,
    pad: pad
  };
})(window);
