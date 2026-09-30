/* ============================================================
   timer.js — 计时引擎（时间戳驱动，标签页节流后仍准确）
   ============================================================ */
(function (global) {
  'use strict';

  var S = global.Store;
  var TICK_MS = 250;
  var MIN_RECORD_SECONDS = 60;   // 少于 1 分钟的中断不记录
  var SLEEP_GUARD_SECONDS = 300; // 超出 5 分钟视为休眠/离线，不自动续接

  var handle = null;
  var listeners = { tick: [], complete: [], change: [], start: [], pause: [], interrupt: [] };

  function on(evt, fn) {
    if (!listeners[evt]) listeners[evt] = [];
    listeners[evt].push(fn);
  }

  function fire(evt, payload) {
    (listeners[evt] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[timer]', e); }
    });
  }

  function durationFor(phase) {
    var s = S.state.settings;
    if (phase === 'short') return Math.max(1, s.short) * 60;
    if (phase === 'long') return Math.max(1, s.long) * 60;
    return Math.max(1, s.focus) * 60;
  }

  function remaining() {
    var t = S.state.timer;
    if (t.running && t.endAt) return Math.max(0, (t.endAt - Date.now()) / 1000);
    return Math.max(0, t.remaining);
  }

  function planned() {
    var t = S.state.timer;
    return t.sessionPlanned || durationFor(t.phase);
  }

  function progress() {
    var total = planned();
    if (total <= 0) return 0;
    return Math.min(1, Math.max(0, 1 - remaining() / total));
  }

  function elapsed() {
    var t = S.state.timer;
    if (t.sessionStartedAt) return (Date.now() - t.sessionStartedAt) / 1000;
    return 0;
  }

  function ensureInterval() {
    if (handle) return;
    var lastSecond = null;
    handle = setInterval(function () {
      var t = S.state.timer;
      if (!t.running) return;
      var rem = remaining();

      // 最后 3 秒滴答
      if (S.state.settings.tickSound) {
        var sec = Math.ceil(rem);
        if (sec <= 3 && sec >= 1 && sec !== lastSecond) {
          lastSecond = sec;
          global.Sound.play('tick');
        }
      }

      if (rem <= 0) {
        complete();
        return;
      }
      fire('tick', { remaining: rem, progress: progress() });
    }, TICK_MS);
  }

  function clearIntervalIfIdle() {
    var t = S.state.timer;
    if (!t.running && handle) {
      clearInterval(handle);
      handle = null;
    }
  }

  /* ---------------- 控制 ---------------- */

  function start() {
    var t = S.state.timer;
    if (t.running) return;
    global.Sound.unlock();
    if (t.remaining <= 0) t.remaining = durationFor(t.phase);
    if (!t.sessionStartedAt) {
      t.sessionStartedAt = Date.now();
      t.sessionPlanned = t.remaining;
    }
    t.running = true;
    t.endAt = Date.now() + t.remaining * 1000;
    S.save();
    ensureInterval();
    fire('start', { phase: t.phase });
    fire('change', snapshot());
  }

  function pause() {
    var t = S.state.timer;
    if (!t.running) return;
    t.remaining = remaining();
    t.running = false;
    t.endAt = null;
    S.save();
    clearIntervalIfIdle();
    fire('pause', { phase: t.phase, remaining: t.remaining });
    fire('change', snapshot());
  }

  function toggle() {
    if (S.state.timer.running) pause();
    else start();
  }

  function setPhase(phase, opts) {
    opts = opts || {};
    var t = S.state.timer;
    if (phase === t.phase && !opts.force) return;
    t.phase = phase;
    t.running = false;
    t.endAt = null;
    t.sessionStartedAt = null;
    t.sessionPlanned = durationFor(phase);
    t.remaining = t.sessionPlanned;
    S.save();
    clearIntervalIfIdle();
    fire('change', snapshot());
    if (opts.autoStart) start();
  }

  /** 写入一条「未完成」的专注记录（原因由 UI 层稍后补上） */
  function recordIncomplete(sec) {
    var t = S.state.timer;
    var task = S.currentTask();
    S.addRecord({
      type: 'focus',
      taskId: task ? task.id : null,
      taskName: task ? task.name : '',
      tag: task ? task.tag : '',
      start: t.sessionStartedAt || (Date.now() - sec * 1000),
      end: Date.now(),
      seconds: sec,
      completed: false,
      reason: '',
      note: ''
    });
  }

  /** 当前阶段归零重来 */
  function reset() {
    var t = S.state.timer;
    var sec = Math.round(elapsed());
    var needReason = t.phase === 'focus' && sec >= MIN_RECORD_SECONDS;
    if (needReason) recordIncomplete(sec);

    t.running = false;
    t.endAt = null;
    t.sessionStartedAt = null;
    t.sessionPlanned = durationFor(t.phase);
    t.remaining = t.sessionPlanned;
    S.save();
    clearIntervalIfIdle();
    fire('change', snapshot());
    if (needReason) fire('interrupt', { seconds: sec, phase: 'focus' });
  }

  /** 跳过当前阶段，进入下一阶段 */
  function skip() {
    var t = S.state.timer;
    var sec = Math.round(elapsed());
    if (t.phase === 'focus' && sec >= MIN_RECORD_SECONDS) {
      recordIncomplete(sec);
      fire('interrupt', { seconds: sec, phase: 'focus', skipped: true });
    }
    advanceTo(computeNext(t.phase, false), {});
  }

  /* ---------------- 阶段流转 ---------------- */

  /** 计算下一个阶段（会按需推进轮次计数） */
  function computeNext(prev, wasCompleted) {
    var t = S.state.timer;
    var settings = S.state.settings;
    if (prev === 'focus') {
      if (wasCompleted) t.cycleCount = (t.cycleCount || 0) + 1;
      return (t.cycleCount >= settings.longEvery) ? 'long' : 'short';
    }
    if (prev === 'long') t.cycleCount = 0;
    return 'focus';
  }

  function advanceTo(next, meta) {
    var t = S.state.timer;
    var settings = S.state.settings;

    t.phase = next;
    t.running = false;
    t.endAt = null;
    t.sessionStartedAt = null;
    t.sessionPlanned = durationFor(next);
    t.remaining = t.sessionPlanned;
    S.save();

    var autoStart = next === 'focus' ? settings.autoStartFocus : settings.autoStartBreak;
    if (meta && meta.noAutoStart) autoStart = false;

    fire('change', snapshot());
    if (autoStart) setTimeout(function () { start(); }, 900);
    clearIntervalIfIdle();
  }

  function complete() {
    var t = S.state.timer;
    var settings = S.state.settings;
    var prev = t.phase;
    var now = Date.now();
    var plannedSec = planned();
    var overshoot = 0;
    if (t.endAt) overshoot = Math.max(0, (now - t.endAt) / 1000);

    var task = S.currentTask();
    var rec = {
      type: prev,
      taskId: task ? task.id : null,
      taskName: task ? task.name : '',
      tag: task ? task.tag : '',
      start: t.sessionStartedAt || (now - plannedSec * 1000),
      end: now,
      seconds: Math.round(plannedSec),
      completed: true,
      reason: '',
      note: ''
    };

    t.running = false;
    t.endAt = null;
    t.remaining = 0;

    S.addRecord(rec);

    if (prev === 'focus' && task) {
      task.pomodoros = (task.pomodoros || 0) + 1;
      task.focusSeconds = (task.focusSeconds || 0) + Math.round(plannedSec);
    }

    var todayCount = S.countToday();
    var next = computeNext(prev, true);
    var goalReached = todayCount === settings.dailyGoal && prev === 'focus';

    // 声音与通知由 app 层处理
    fire('complete', {
      phase: prev,
      next: next,
      record: rec,
      todayCount: todayCount,
      goalReached: goalReached,
      overshoot: overshoot,
      task: task ? { id: task.id, name: task.name } : null
    });

    advanceTo(next, { noAutoStart: overshoot > SLEEP_GUARD_SECONDS });
    S.emit();
  }

  /** 回到前台时立即校准一次 */
  function check() {
    var t = S.state.timer;
    if (t.running && remaining() <= 0) complete();
    else fire('tick', { remaining: remaining(), progress: progress() });
  }

  /* ---------------- 快照 ---------------- */

  function snapshot() {
    var t = S.state.timer;
    var settings = S.state.settings;
    return {
      phase: t.phase,
      running: t.running,
      remaining: remaining(),
      planned: planned(),
      progress: progress(),
      cycleCount: t.cycleCount || 0,
      longEvery: settings.longEvery,
      remainingToLong: Math.max(0, settings.longEvery - (t.cycleCount || 0)),
      durations: {
        focus: settings.focus,
        short: settings.short,
        long: settings.long
      }
    };
  }

  /* ---------------- 恢复 ---------------- */

  function restore() {
    var t = S.state.timer;
    if (t.running && t.endAt && t.endAt > Date.now()) {
      ensureInterval();
    }
  }

  global.Timer = {
    on: on,
    start: start,
    pause: pause,
    toggle: toggle,
    reset: reset,
    skip: skip,
    check: check,
    setPhase: setPhase,
    remaining: remaining,
    planned: planned,
    progress: progress,
    elapsed: elapsed,
    durationFor: durationFor,
    snapshot: snapshot,
    restore: restore,
    MIN_RECORD_SECONDS: MIN_RECORD_SECONDS
  };
})(window);
