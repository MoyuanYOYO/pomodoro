/* ============================================================
   无头逻辑测试：在 Node 里加载 store/timer/stats，跑完整番茄周期
   运行： node tools/test-engine.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');

function makeContext(sharedDisk) {
  const disk = sharedDisk || {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(disk, k) ? disk[k] : null; },
      setItem(k, v) { disk[k] = String(v); },
      removeItem(k) { delete disk[k]; }
    }
  };
  sandbox.window = sandbox;
  sandbox.__disk = disk;
  const ctx = vm.createContext(sandbox);
  // 声音引擎桩
  vm.runInContext('window.Sound = { unlock(){}, play(){}, startAmbient(){}, stopAmbient(){}, setAmbientVolume(){}, isAmbientPlaying:false, ambientKind:"none" };', ctx);
  ['store.js', 'timer.js', 'stats.js'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), ctx, { filename: f });
  });
  return sandbox;
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, actual, expected) {
  ok(name + ' (=' + JSON.stringify(expected) + ')', actual === expected, actual);
}
function section(t) { console.log('\n' + t); }

const w = makeContext();
const Store = w.Store;
const Timer = w.Timer;
const Stats = w.Stats;

section('1. 初始化与默认设置');
Store.load();
eq('默认专注时长', Store.state.settings.focus, 25);
eq('默认短休时长', Store.state.settings.short, 5);
eq('默认长休时长', Store.state.settings.long, 15);
eq('默认长休间隔', Store.state.settings.longEvery, 4);
eq('初始阶段', Store.state.timer.phase, 'focus');
eq('初始剩余 = 25 分钟', Store.state.timer.remaining, 1500);
eq('初始今日番茄', Store.countToday(), 0);

// 关掉自动开始，方便断言
Store.set({ settings: { autoStartBreak: false, autoStartFocus: false } });

section('2. 任务关联');
const task = Store.findOrCreateTaskByName('写周报');
Store.state.currentTaskId = task.id;
ok('任务已创建', !!task.id);
eq('同名任务不重复创建', Store.findOrCreateTaskByName('写周报').id, task.id);
eq('任务初始番茄数', task.pomodoros, 0);

section('3. 计时：开始 / 暂停 / 继续 / 重置');
Timer.setPhase('focus');
Timer.start();
ok('开始后 running=true', Store.state.timer.running === true);
ok('endAt 约等于 now+1500s', Math.abs(Store.state.timer.endAt - Date.now() - 1500000) < 1500);
Timer.pause();
ok('暂停后 running=false', Store.state.timer.running === false);
ok('暂停后保留剩余时间', Store.state.timer.remaining > 1495 && Store.state.timer.remaining <= 1500, Store.state.timer.remaining);
Timer.start();
ok('继续后 running=true', Store.state.timer.running === true);
Timer.reset();
eq('重置后剩余回到满值', Math.round(Timer.remaining()), 1500);
eq('重置后阶段不变', Store.state.timer.phase, 'focus');

section('4. 完整番茄周期：4 个专注 → 长休');
function finishPhase() {
  Store.state.timer.endAt = Date.now() - 1000;
  Timer.check();
}
const phases = [];
for (let i = 1; i <= 4; i++) {
  Timer.setPhase('focus');
  Timer.start();
  finishPhase();
  phases.push('focus#' + i + '→' + Store.state.timer.phase);
  if (Store.state.timer.phase !== 'long') {
    Timer.start();
    finishPhase();
    phases.push('break→' + Store.state.timer.phase);
  }
}
console.log('     流转：' + phases.join('  |  '));
eq('完成 4 个番茄后进入长休', Store.state.timer.phase, 'long');
eq('轮次计数 = 4', Store.state.timer.cycleCount, 4);
eq('今日番茄数 = 4', Store.countToday(), 4);
eq('任务累计番茄 = 4', task.pomodoros, 4);
eq('任务累计专注秒数 = 6000', task.focusSeconds, 6000);

section('5. 长休结束后开启新一轮');
Timer.start();
finishPhase();
eq('长休后回到专注', Store.state.timer.phase, 'focus');
eq('轮次计数归零', Store.state.timer.cycleCount, 0);

section('6. 距长休剩余数');
Store.state.timer.cycleCount = 1;
eq('剩余到长休 = 3', Timer.snapshot().remainingToLong, 3);
Store.state.timer.cycleCount = 0;

section('7. 中断记录（未满 1 分钟不记录）');
const before = Store.state.records.length;
Timer.setPhase('focus');
Timer.start();
Timer.reset();
eq('刚开始就重置不产生记录', Store.state.records.length, before);

Timer.start();
Store.state.timer.sessionStartedAt = Date.now() - 200 * 1000; // 假装已过 200 秒
Timer.reset();
eq('超过 1 分钟的重置产生 1 条记录', Store.state.records.length, before + 1);
const lastRec = Store.state.records[Store.state.records.length - 1];
eq('该记录标记为未完成', lastRec.completed, false);
eq('该记录时长 200 秒', lastRec.seconds, 200);
ok('中断未计入今日番茄', Store.countToday() === 4, Store.countToday());

section('8. 跳过阶段');
const cycleBeforeSkip = Store.state.timer.cycleCount;
Timer.setPhase('focus', { force: true });
Timer.start();
Store.state.timer.sessionStartedAt = Date.now() - 300 * 1000;
Timer.skip();
eq('跳过后进入短休', Store.state.timer.phase, 'short');
eq('跳过不增加轮次', Store.state.timer.cycleCount, cycleBeforeSkip);
const skipRec = Store.state.records[Store.state.records.length - 1];
eq('跳过写入未完成记录', skipRec.completed, false);
eq('跳过记录时长 300 秒', skipRec.seconds, 300);

section('9. 统计聚合');
const day = Stats.aggregate('day');
eq('今日番茄 = 4', day.pomodoros, 4);
eq('今日专注分钟 = 100', day.focusMinutes, 100);
eq('任务分布条目数 = 1', day.byTask.length, 1);
eq('任务分布第一名', day.byTask[0].name, '写周报');
ok('中断次数 >= 2', day.interruptions.length >= 2, day.interruptions.length);
const week = Stats.aggregate('week');
eq('本周番茄 = 4', week.pomodoros, 4);
eq('本周序列长度 = 7', week.series.length, 7);
const month = Stats.aggregate('month');
eq('近 30 天序列长度 = 30', month.series.length, 30);
ok('柱状图能渲染出 SVG', Stats.barChart(day.series, '#FF6B5A').indexOf('<svg') === 0);
ok('任务分布能渲染', Stats.taskDistribution(day.byTask).indexOf('dist-list') > 0);

section('10. 本地持久化（重开数据仍在）');
Store.state.settings.focus = 30;
Store.state.settings.longEvery = 5;
Store.saveNow();
const w2 = makeContext(w.__disk);
w2.Store.load();
eq('重开后专注时长 = 30', w2.Store.state.settings.focus, 30);
eq('重开后长休间隔 = 5', w2.Store.state.settings.longEvery, 5);
eq('重开后任务数 = 1', w2.Store.state.tasks.length, 1);
eq('重开后任务番茄数 = 4', w2.Store.state.tasks[0].pomodoros, 4);
eq('重开后记录数一致', w2.Store.state.records.length, Store.state.records.length);
eq('重开后今日番茄 = 4', w2.Store.countToday(), 4);
ok('重开后阶段已保存', typeof w2.Store.state.timer.phase === 'string');

section('11. 边界情况');
const w3 = makeContext();
w3.Store.load();
w3.Store.set({ settings: { focus: 0, short: -3, long: 999 } });
ok('非法时长为 0 时按 1 分钟兜底', w3.Timer.durationFor('focus') === 60, w3.Timer.durationFor('focus'));
ok('负数时长兜底为 1 分钟', w3.Timer.durationFor('short') === 60, w3.Timer.durationFor('short'));
ok('时长格式化 90 分钟', w3.Store.fmtDuration(90) === '1 小时 30 分', w3.Store.fmtDuration(90));
ok('时钟格式化 1500 秒', w3.Store.fmtClock(1500) === '25:00', w3.Store.fmtClock(1500));

section('结果');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
