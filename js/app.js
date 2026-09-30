/* ============================================================
   app.js — 界面装配与全部业务交互
   ============================================================ */
(function (global) {
  'use strict';

  var S = global.Store;
  var T = global.Timer;
  var Sound = global.Sound;
  var Stats = global.Stats;
  var doc = document;

  var PHASE_NAMES = { focus: '专注', short: '短休息', long: '长休息' };
  var PHASE_COLORS = { focus: '#FF6B5A', short: '#6FC7B6', long: '#7FA8D8' };
  var REASONS = ['内部干扰', '外部打断', '任务切换', '临时离开', '状态不佳', '其他'];

  var $ = function (id) { return doc.getElementById(id); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); };

  var el = {};
  var state = {
    view: 'timer',
    statsRange: 'day',
    editingTaskId: null,
    modalSubs: [],
    pickedReason: '',
    pendingInterrupt: null,
    focusMode: false,
    lastGoalNotified: ''
  };
  var mqlDark = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;

  /* ============================================================ 工具 */

  function toast(msg, ms) {
    var node = doc.createElement('div');
    node.className = 'toast';
    node.textContent = msg;
    el.toastWrap.appendChild(node);
    setTimeout(function () {
      node.classList.add('is-out');
      setTimeout(function () { node.remove(); }, 320);
    }, ms || 2600);
  }

  function esc(s) { return Stats.esc(s); }

  function isTyping(e) {
    var t = e.target;
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }

  /* ============================================================ 主题 */

  function effectiveTheme() {
    var mode = S.state.settings.theme;
    if (mode === 'dark') return 'dark';
    if (mode === 'light') return 'light';
    return (mqlDark && mqlDark.matches) ? 'dark' : 'light';
  }

  function applyTheme() {
    var t = effectiveTheme();
    doc.documentElement.setAttribute('data-theme', t);
    var meta = doc.querySelector('meta[name="theme-color"]');
    var bg = t === 'dark' ? '#111315' : '#FAF8F5';
    $$('meta[name="theme-color"]').forEach(function (m) { m.setAttribute('content', bg); });
    if (meta) meta.setAttribute('content', bg);
    if (global.pomodoroBridge) global.pomodoroBridge.setTheme(t);
  }

  function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    var cur = S.state.settings.theme;
    var next = order[(order.indexOf(cur) + 1) % order.length];
    S.set({ settings: { theme: next } });
    applyTheme();
    paintSettings();
    toast('主题：' + ({ auto: '跟随系统', light: '浅色', dark: '深色' })[next]);
  }

  /* ============================================================ 渲染：计时 */

  function paintTimer(snap) {
    snap = snap || T.snapshot();
    var body = doc.body;
    body.setAttribute('data-phase', snap.phase);
    body.classList.toggle('is-running', snap.running);
    body.classList.toggle('is-paused', !snap.running && snap.progress > 0.001);

    var timeText = S.fmtClock(snap.remaining);
    el.timeDisplay.textContent = timeText;
    el.phaseLabel.textContent = PHASE_NAMES[snap.phase];
    el.focusTime.textContent = timeText;
    el.focusPhase.textContent = PHASE_NAMES[snap.phase];

    // 圆环
    var C = 2 * Math.PI * 140;
    el.ringProgress.style.strokeDasharray = C.toFixed(2);
    el.ringProgress.style.strokeDashoffset = (C * (1 - snap.progress)).toFixed(2);

    // 阶段按钮
    $$('.phase-tab').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.phase === snap.phase);
    });

    // 主按钮
    var label = snap.running ? '暂停' : (snap.progress > 0.001 ? '继续' : '开始');
    el.btnStart.textContent = label;
    el.focusStart.textContent = label;

    // 轮次圆点
    var every = snap.longEvery || 4;
    var dots = '';
    for (var i = 0; i < every; i++) {
      var cls = 'cycle-dot';
      if (i < snap.cycleCount) cls += ' done';
      else if (i === snap.cycleCount && snap.phase === 'focus') cls += ' current';
      dots += '<span class="' + cls + '"></span>';
    }
    el.cycleDots.innerHTML = dots;

    var left = Math.max(0, every - snap.cycleCount);
    el.cycleHint.textContent = snap.phase === 'long'
      ? '长休息中 · 结束后开始新一轮'
      : (left === 0 ? '下一个就是长休息' : '再完成 ' + left + ' 个番茄进入长休');

    // 标题与托盘
    var title = snap.running || snap.progress > 0.001
      ? timeText + ' · ' + PHASE_NAMES[snap.phase] + ' · 番茄钟'
      : '番茄钟 · Pomodoro';
    doc.title = title;
    updateTray(snap, title);
  }

  function updateTray(snap, title) {
    if (!global.pomodoroBridge) return;
    try {
      global.pomodoroBridge.updateTray({
        title: title,
        text: S.fmtClock(snap.remaining),
        phase: PHASE_NAMES[snap.phase],
        running: snap.running,
        progress: snap.progress,
        color: PHASE_COLORS[snap.phase],
        showCountdown: !!S.state.settings.showTrayCountdown
      });
    } catch (e) { /* noop */ }
  }

  function paintToday() {
    var count = S.countToday();
    var sec = S.focusSecondsToday();
    var goal = S.state.settings.dailyGoal || 8;
    el.todayCount.textContent = String(count);
    el.todayFocus.textContent = sec >= 3600
      ? (sec / 3600).toFixed(1) + ' 小时'
      : Math.round(sec / 60) + ' 分';
    el.todayGoal.textContent = count + ' / ' + goal;
  }

  /* ============================================================ 渲染：任务 */

  function sortedTasks() {
    var list = S.state.tasks.slice();
    list.sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return b.createdAt - a.createdAt;
    });
    return list;
  }

  function paintTasks() {
    var tasks = sortedTasks();
    var curId = S.state.currentTaskId;
    var totalPomos = 0;

    if (!tasks.length) {
      el.taskList.innerHTML = '';
      el.taskEmpty.hidden = false;
      el.taskSummary.textContent = '0 项';
    } else {
      el.taskEmpty.hidden = true;
      el.taskList.innerHTML = tasks.map(function (t) {
        totalPomos += t.pomodoros || 0;
        var doneSubs = (t.subs || []).filter(function (s) { return s.done; }).length;
        var subCount = (t.subs || []).length;
        var meta = [];
        if (t.tag) meta.push('<span class="chip chip-tag">' + esc(t.tag) + '</span>');
        if (subCount) {
          meta.push('<span class="sub-progress"><span class="sub-bar"><i style="width:' +
            Math.round(doneSubs / subCount * 100) + '%"></i></span>' + doneSubs + '/' + subCount + '</span>');
        }
        if (t.estimate > 1) meta.push('<span>预估 ' + t.estimate + '</span>');
        return '<li class="task-item' + (t.id === curId ? ' is-current' : '') + (t.done ? ' is-done' : '') +
          '" data-id="' + t.id + '">' +
          '<button class="task-check" data-act="toggle" aria-label="标记完成">' +
          '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
          '<div class="task-body">' +
          '<span class="task-name">' + esc(t.name) + '</span>' +
          (meta.length ? '<span class="task-sub">' + meta.join('') + '</span>' : '') +
          '</div>' +
          '<span class="task-pomos">' + (t.pomodoros || 0) + '</span>' +
          '<button class="task-more" data-act="edit" aria-label="编辑任务">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>' +
          '</button></li>';
      }).join('');
      el.taskSummary.textContent = tasks.length + ' 项 · ' + totalPomos + ' 个番茄';
    }

    // 当前任务
    var cur = S.currentTask();
    if (cur) {
      el.quickTaskInput.value = cur.name;
      el.currentTaskMeta.hidden = false;
      el.currentTaskChip.textContent = cur.name;
      el.currentTaskPomos.textContent = (cur.pomodoros || 0) + ' 个番茄';
      el.focusTask.textContent = cur.name;
    } else {
      el.currentTaskMeta.hidden = true;
      el.focusTask.textContent = '未选择任务';
    }
  }

  function setCurrentTask(id, silent) {
    S.set({ currentTaskId: id });
    paintTasks();
    if (!silent && id) {
      var t = S.getTask(id);
      if (t) toast('已选择任务：' + t.name);
    }
  }

  /* ============================================================ 渲染：统计 */

  function paintStats() {
    var d = Stats.aggregate(state.statsRange);

    var cards = [
      { k: '完成番茄', v: d.pomodoros, s: '个', d: d.rangeLabel, accent: true },
      { k: '专注时长', v: d.focusMinutes >= 60 ? (d.focusMinutes / 60).toFixed(1) : d.focusMinutes, s: d.focusMinutes >= 60 ? '小时' : '分钟', d: S.fmtDuration(d.focusMinutes) },
      { k: '日均番茄', v: d.avgPerDay, s: '个', d: '按 ' + d.dayCount + ' 天计算' },
      { k: '目标达成率', v: d.goalRate, s: '%', d: '目标 ' + d.goal + ' 个/天' },
      { k: '中断次数', v: d.interruptions.length, s: '次', d: d.interruptions.length ? '可查看原因' : '保持得不错' }
    ];
    el.statCards.innerHTML = cards.map(function (c) {
      return '<div class="stat-card' + (c.accent ? ' accent' : '') + '">' +
        '<span class="k">' + c.k + '</span>' +
        '<span class="v">' + c.v + '<small>' + c.s + '</small></span>' +
        '<span class="d">' + esc(c.d) + '</span></div>';
    }).join('');

    var color = state.statsRange === 'day' ? '#FF6B5A' : (state.statsRange === 'week' ? '#6FC7B6' : '#7FA8D8');
    el.trendChart.innerHTML = Stats.barChart(d.series, color);
    el.trendHint.textContent = d.rangeLabel + ' · 单位：分钟';
    el.taskChart.innerHTML = Stats.taskDistribution(d.byTask);

    el.recordHint.textContent = d.recordsInRange.length + ' 条';
    el.recordList.innerHTML = Stats.recordList(d.recordsInRange, 40);

    var ints = d.interruptions.slice().sort(function (a, b) { return b.start - a.start; });
    el.interruptHint.textContent = ints.length ? ints.length + ' 次' : '未完成的专注会记录原因';
    el.interruptList.innerHTML = ints.length
      ? ints.slice(0, 30).map(function (r) {
        var dt = new Date(r.start);
        return '<li class="record-item">' +
          '<span class="record-dot" style="background:#E5484D"></span>' +
          '<div class="record-main"><span class="t">' + esc(r.taskName || '未关联任务') + '</span>' +
          '<span class="s">' + esc((dt.getMonth() + 1) + '月' + dt.getDate() + '日 ' + S.fmtTimeHM(r.start) +
            ' · ' + (r.reason || '未记录原因') + (r.note ? ' · ' + r.note : '')) + '</span></div>' +
          '<span class="record-time">' + Math.round(r.seconds / 60) + '′</span></li>';
      }).join('')
      : '<div class="empty-hint" style="padding:26px 0">没有中断记录</div>';
  }

  /* ============================================================ 渲染：设置 */

  function bindSetting(id, key, type) {
    var node = $(id);
    if (!node) return;
    var evt = (type === 'checkbox' || type === 'range' || type === 'number') ? 'input' : 'change';
    node.addEventListener(evt, function () {
      var val = type === 'checkbox' ? node.checked
        : (type === 'number' || type === 'range') ? parseFloat(node.value)
          : node.value;
      if (type === 'number') {
        if (isNaN(val)) return;
        var min = parseFloat(node.min), max = parseFloat(node.max);
        if (!isNaN(min)) val = Math.max(min, val);
        if (!isNaN(max)) val = Math.min(max, val);
      }
      var patch = {};
      patch[key] = val;
      S.set({ settings: patch });
      if (key === 'theme') { applyTheme(); paintSettings(); }
      if (key === 'ambientVolume') Sound.setAmbientVolume(val);
      if (key === 'soundVolume' && type === 'range') { /* 下次播放生效 */ }
      if (key === 'alwaysOnTop' && global.pomodoroBridge) global.pomodoroBridge.setAlwaysOnTop(val);
      if (key === 'minimizeToTray' && global.pomodoroBridge) global.pomodoroBridge.setMinimizeToTray(val);
      if (key === 'showTrayCountdown') paintTimer();
      if (key === 'focus' || key === 'short' || key === 'long') {
        // 未开始的当前阶段同步刷新
        var snap = T.snapshot();
        var t = S.state.timer;
        if (!t.running && !t.sessionStartedAt) {
          t.remaining = T.durationFor(t.phase);
          t.sessionPlanned = t.remaining;
          S.save();
          paintTimer();
        }
      }
      paintToday();
      if (state.view === 'stats') paintStats();
    });
  }

  function paintSettings() {
    var s = S.state.settings;
    $('setFocus').value = s.focus;
    $('setShort').value = s.short;
    $('setLong').value = s.long;
    $('setLongEvery').value = s.longEvery;
    $('setAutoBreak').checked = !!s.autoStartBreak;
    $('setAutoFocus').checked = !!s.autoStartFocus;
    $('setGoal').value = s.dailyGoal;
    $('setSound').checked = !!s.soundOn;
    $('setVolume').value = s.soundVolume;
    $('setTick').checked = !!s.tickSound;
    $('setNotify').checked = !!s.notify;
    $('setAmbientVolume').value = s.ambientVolume;
    $('setTray').checked = !!s.showTrayCountdown;
    $('setMinimize').checked = !!s.minimizeToTray;
    $('setOnTop').checked = !!s.alwaysOnTop;

    $$('#setTheme .seg-item').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.theme === s.theme);
    });

    el.storageInfo.textContent = 'localStorage';
    var bytes = S.storageSize();
    el.dataInfo.textContent = S.state.records.length + ' 条记录 · ' + S.state.tasks.length + ' 个任务 · ' +
      (bytes > 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B');

    // 环境音按钮
    $$('.ambient-item').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.ambient === s.ambient);
    });
    el.btnAmbientToggle.textContent = Sound.isAmbientPlaying ? '暂停' : '播放';
  }

  /* ============================================================ 通知 */

  function ensureNotifyPermission() {
    if (!S.state.settings.notify) return;
    if (!('Notification' in global)) return;
    if (Notification.permission !== 'default') return;
    try {
      var p = Notification.requestPermission();
      // 部分环境（无头 / 受限权限）会 reject，静默忽略
      if (p && typeof p.catch === 'function') {
        p.catch(function () { /* 用户拒绝或环境不支持 */ });
      }
    } catch (e) { /* 老式浏览器同步抛错 */ }
  }

  function notify(title, body) {
    if (!S.state.settings.notify) return;
    if (global.pomodoroBridge && global.pomodoroBridge.notify) {
      try { global.pomodoroBridge.notify(title, body); return; } catch (e) { /* fallthrough */ }
    }
    if (!('Notification' in global)) return;
    if (Notification.permission === 'granted') {
      try {
        new Notification(title, { body: body, icon: 'icons/icon-192.png', tag: 'pomodoro', silent: true });
      } catch (e) { /* noop */ }
    }
  }

  /* ============================================================ 完成回调 */

  T.on('tick', function (p) {
    var snap = T.snapshot();
    paintTimer(snap);
  });

  T.on('change', function () {
    paintTimer();
    paintToday();
    paintTasks();
    paintSettings();
  });

  T.on('complete', function (info) {
    var s = S.state.settings;
    if (s.soundOn) {
      Sound.play(info.phase === 'focus' ? 'focusEnd' : 'breakEnd');
    }

    if (info.phase === 'focus') {
      notify('专注结束 · 已完成 ' + info.todayCount + ' 个番茄',
        info.next === 'long' ? '干得漂亮，来一段长休息吧' : '起来动一动，休息 5 分钟');
      toast('完成 1 个番茄 · 今日 ' + info.todayCount + ' 个' +
        (info.task ? '（' + info.task.name + '）' : ''));
    } else {
      notify(PHASE_NAMES[info.phase] + '结束', '准备好开始下一个专注了吗？');
      toast(PHASE_NAMES[info.phase] + '结束，回到专注');
    }

    if (info.goalReached) {
      if (s.soundOn) setTimeout(function () { Sound.play('goal'); }, 700);
      toast('🎉 达成今日目标：' + s.dailyGoal + ' 个番茄！', 4200);
      notify('今日目标达成', '已经完成 ' + s.dailyGoal + ' 个番茄，继续保持');
    }

    paintTimer();
    paintToday();
    paintTasks();
    if (state.view === 'stats') paintStats();
  });

  T.on('interrupt', function (p) {
    openBreakModal(p);
  });

  /* ============================================================ 中断原因弹窗 */

  function openBreakModal(p) {
    state.pickedReason = '';
    el.breakModalText.textContent = '已专注 ' + Math.round(p.seconds / 60) + ' 分钟，不计入番茄数。记录一下原因，之后可以回顾。';
    el.reasonGrid.innerHTML = REASONS.map(function (r) {
      return '<button class="reason-item" data-reason="' + esc(r) + '">' + esc(r) + '</button>';
    }).join('');
    el.breakNote.value = '';
    el.breakModalScrim.hidden = false;
    state.pendingInterrupt = p;
  }

  function closeBreakModal() {
    el.breakModalScrim.hidden = true;
    state.pendingInterrupt = null;
  }

  function saveBreakReason() {
    var p = state.pendingInterrupt;
    if (!p) return closeBreakModal();
    // 找到刚写入的那条未完成记录并补上原因
    var recs = S.state.records;
    for (var i = recs.length - 1; i >= 0; i--) {
      if (recs[i].type === 'focus' && !recs[i].completed && !recs[i].reason) {
        recs[i].reason = state.pickedReason || '未说明';
        recs[i].note = el.breakNote.value.trim();
        break;
      }
    }
    S.saveNow();
    closeBreakModal();
    if (state.view === 'stats') paintStats();
    toast('已记录中断原因');
  }

  /* ============================================================ 任务弹窗 */

  function openTaskModal(id) {
    state.editingTaskId = id || null;
    var t = id ? S.getTask(id) : null;
    el.taskModalTitle.textContent = t ? '编辑任务' : '新建任务';
    el.tmName.value = t ? t.name : '';
    el.tmTag.value = t ? t.tag : '';
    el.tmEstimate.value = t ? t.estimate : 1;
    state.modalSubs = t ? t.subs.map(function (s) { return { id: s.id, name: s.name, done: s.done }; }) : [];
    paintModalSubs();
    el.btnDeleteTask.hidden = !t;
    el.taskModalScrim.hidden = false;
    setTimeout(function () { el.tmName.focus(); }, 60);
  }

  function closeTaskModal() {
    el.taskModalScrim.hidden = true;
    state.editingTaskId = null;
  }

  function paintModalSubs() {
    el.tmSubtasks.innerHTML = state.modalSubs.length
      ? state.modalSubs.map(function (s, i) {
        return '<li class="subtask-row' + (s.done ? ' is-done' : '') + '" data-idx="' + i + '">' +
          '<button class="task-check' + (s.done ? '' : '') + '" data-sub-act="toggle" style="' + (s.done ? 'background:#6FC7B6;border-color:#6FC7B6' : '') + '">' +
          '<svg viewBox="0 0 24 24" fill="none" style="opacity:' + (s.done ? 1 : 0) + '"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
          '<span class="name">' + esc(s.name) + '</span>' +
          '<button class="task-more" data-sub-act="del" style="opacity:1" aria-label="删除子任务">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>' +
          '</button></li>';
      }).join('')
      : '<li class="muted" style="padding:6px 2px">暂无子任务</li>';
  }

  function addModalSub() {
    var v = el.tmSubInput.value.trim();
    if (!v) return;
    state.modalSubs.push({ id: S.uid('sub'), name: v, done: false });
    el.tmSubInput.value = '';
    paintModalSubs();
    el.tmSubInput.focus();
  }

  function saveTask() {
    var name = el.tmName.value.trim();
    if (!name) { el.tmName.focus(); toast('请填写任务名称'); return; }
    var tag = el.tmTag.value.trim();
    var estimate = Math.max(1, parseInt(el.tmEstimate.value, 10) || 1);

    if (state.editingTaskId) {
      var t = S.getTask(state.editingTaskId);
      if (t) {
        t.name = name;
        t.tag = tag;
        t.estimate = estimate;
        t.subs = state.modalSubs;
      }
    } else {
      var nt = {
        id: S.uid('task'),
        name: name,
        tag: tag,
        estimate: estimate,
        done: false,
        pomodoros: 0,
        focusSeconds: 0,
        createdAt: Date.now(),
        subs: state.modalSubs
      };
      S.state.tasks.unshift(nt);
      S.state.currentTaskId = nt.id;
    }
    S.saveNow();
    closeTaskModal();
    paintTasks();
    paintTagOptions();
    toast(state.editingTaskId ? '任务已更新' : '任务已创建');
  }

  function deleteTask() {
    var id = state.editingTaskId;
    if (!id) return;
    S.state.tasks = S.state.tasks.filter(function (t) { return t.id !== id; });
    if (S.state.currentTaskId === id) S.state.currentTaskId = null;
    S.saveNow();
    closeTaskModal();
    paintTasks();
    toast('任务已删除');
  }

  function paintTagOptions() {
    el.tagOptions.innerHTML = S.allTags().map(function (t) {
      return '<option value="' + esc(t) + '"></option>';
    }).join('');
  }

  /* ============================================================ 环境音 */

  function setAmbient(kind) {
    var s = S.state.settings;
    Sound.unlock();
    if (kind === 'none' || kind === s.ambient && Sound.isAmbientPlaying) {
      Sound.stopAmbient();
      S.set({ settings: { ambient: 'none', ambientPlaying: false } });
    } else {
      Sound.startAmbient(kind, s.ambientVolume);
      S.set({ settings: { ambient: kind, ambientPlaying: true } });
    }
    paintSettings();
  }

  function toggleAmbient() {
    var s = S.state.settings;
    Sound.unlock();
    if (Sound.isAmbientPlaying) {
      Sound.stopAmbient();
      S.set({ settings: { ambientPlaying: false } });
      paintSettings();
    } else {
      var kind = s.ambient && s.ambient !== 'none' ? s.ambient : 'brown';
      Sound.startAmbient(kind, s.ambientVolume);
      S.set({ settings: { ambient: kind, ambientPlaying: true } });
      paintSettings();
    }
  }

  /* ============================================================ 导出 / 导入 */

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 500);
  }

  function stamp() {
    var d = new Date();
    return '' + d.getFullYear() + S.pad(d.getMonth() + 1) + S.pad(d.getDate());
  }

  function exportCsv() {
    var rows = [['日期', '开始时间', '结束时间', '类型', '任务', '标签', '时长(分钟)', '是否完成', '中断原因', '备注']];
    var recs = S.state.records.slice().sort(function (a, b) { return a.start - b.start; });
    recs.forEach(function (r) {
      rows.push([
        S.dayKey(r.start),
        S.fmtTimeHM(r.start),
        S.fmtTimeHM(r.end),
        PHASE_NAMES[r.type] || r.type,
        r.taskName || '',
        r.tag || '',
        Math.round(r.seconds / 60),
        r.completed ? '是' : '否',
        r.reason || '',
        r.note || ''
      ]);
    });
    var csv = rows.map(function (row) {
      return row.map(function (c) {
        var s = String(c == null ? '' : c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
    download('pomodoro-' + stamp() + '.csv', '\ufeff' + csv, 'text/csv;charset=utf-8');
    toast('已导出 ' + recs.length + ' 条记录');
  }

  function exportJson() {
    download('pomodoro-backup-' + stamp() + '.json',
      JSON.stringify(S.state, null, 2), 'application/json');
    toast('已导出完整数据备份');
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object') throw new Error('格式不正确');
        S.set({
          settings: data.settings || {},
          tasks: Array.isArray(data.tasks) ? data.tasks : [],
          records: Array.isArray(data.records) ? data.records : [],
          currentTaskId: data.currentTaskId || null,
          timer: data.timer || {}
        });
        S.saveNow();
        toast('导入成功，正在刷新…');
        setTimeout(function () { location.reload(); }, 700);
      } catch (e) {
        toast('导入失败：' + e.message);
      }
    };
    reader.readAsText(file);
  }

  /* ============================================================ 视图切换 */

  function setView(name) {
    state.view = name;
    $$('.view').forEach(function (v) {
      var on = v.dataset.view === name;
      v.classList.toggle('is-active', on);
      v.hidden = !on;
    });
    $$('.nav-item').forEach(function (b) {
      var on = b.dataset.view === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (name === 'stats') paintStats();
  }

  /* ============================================================ 专注模式 */

  function toggleFocusMode(force) {
    var on = typeof force === 'boolean' ? force : !state.focusMode;
    state.focusMode = on;
    el.focusOverlay.hidden = !on;
    el.btnFocusMode.classList.toggle('is-on', on);
    if (on) {
      try {
        if (doc.documentElement.requestFullscreen) doc.documentElement.requestFullscreen();
      } catch (e) { /* noop */ }
    } else {
      try {
        if (doc.fullscreenElement && doc.exitFullscreen) doc.exitFullscreen();
      } catch (e) { /* noop */ }
    }
    paintTimer();
  }

  /* ============================================================ 抽屉 */

  function openSettings() {
    el.scrim.hidden = false;
    requestAnimationFrame(function () {
      el.scrim.classList.add('is-open');
      el.drawer.classList.add('is-open');
    });
    el.drawer.setAttribute('aria-hidden', 'false');
    paintSettings();
  }

  function closeSettings() {
    el.drawer.classList.remove('is-open');
    el.scrim.classList.remove('is-open');
    el.drawer.setAttribute('aria-hidden', 'true');
    setTimeout(function () { el.scrim.hidden = true; }, 320);
  }

  /* ============================================================ 事件绑定 */

  function bindEvents() {
    // 阶段
    $$('.phase-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        if (S.state.timer.running) {
          if (!confirm('当前阶段还在进行，切换会中断它。继续？')) return;
          T.pause();
        }
        T.setPhase(b.dataset.phase);
      });
    });

    // 控制
    el.btnStart.addEventListener('click', function () { T.toggle(); ensureNotifyPermission(); });
    el.btnReset.addEventListener('click', function () { T.reset(); });
    el.btnSkip.addEventListener('click', function () { T.skip(); });

    el.focusStart.addEventListener('click', function () { T.toggle(); });
    el.focusReset.addEventListener('click', function () { T.reset(); });
    el.focusSkip.addEventListener('click', function () { T.skip(); });
    el.btnFocusMode.addEventListener('click', function () { toggleFocusMode(); });

    // 导航
    $$('.nav-item').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.dataset.view); });
    });

    // 主题 / 设置
    el.btnTheme.addEventListener('click', cycleTheme);
    el.btnSettings.addEventListener('click', openSettings);
    el.btnCloseSettings.addEventListener('click', closeSettings);
    el.scrim.addEventListener('click', closeSettings);

    // 统计区间
    $$('#statsRange .seg-item').forEach(function (b) {
      b.addEventListener('click', function () {
        state.statsRange = b.dataset.range;
        $$('#statsRange .seg-item').forEach(function (x) {
          x.classList.toggle('is-active', x === b);
        });
        paintStats();
      });
    });

    // 导出导入
    el.btnExportCsv.addEventListener('click', exportCsv);
    el.btnExportJson.addEventListener('click', exportJson);
    el.btnExportCsv2.addEventListener('click', exportCsv);
    el.btnExportJson2.addEventListener('click', exportJson);
    el.btnImportJson.addEventListener('click', function () { el.fileImport.click(); });
    el.fileImport.addEventListener('change', function () {
      if (this.files && this.files[0]) importJson(this.files[0]);
      this.value = '';
    });
    el.btnSyncInfo.addEventListener('click', function () {
      toast('跨设备同步：导出 JSON 备份，在另一台设备导入即可。也可把备份文件放进网盘同步目录，手动保持一致。', 5200);
    });
    el.btnWipe.addEventListener('click', function () {
      if (!confirm('确定清空全部数据？任务、记录和设置都会被删除，无法撤销。')) return;
      S.reset();
      closeSettings();
      location.reload();
    });

    // 任务
    el.btnAddTask.addEventListener('click', function () { openTaskModal(null); });
    el.btnCloseTaskModal.addEventListener('click', closeTaskModal);
    el.btnCancelTask.addEventListener('click', closeTaskModal);
    el.taskModalScrim.addEventListener('click', function (e) {
      if (e.target === el.taskModalScrim) closeTaskModal();
    });
    el.btnSaveTask.addEventListener('click', saveTask);
    el.btnDeleteTask.addEventListener('click', function () {
      if (confirm('删除这个任务？已记录的番茄数据会保留。')) deleteTask();
    });
    el.btnAddSub.addEventListener('click', addModalSub);
    el.tmSubInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addModalSub(); }
    });
    el.tmSubtasks.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-sub-act]');
      if (!btn) return;
      var row = btn.closest('.subtask-row');
      var idx = parseInt(row.dataset.idx, 10);
      if (btn.dataset.subAct === 'toggle') state.modalSubs[idx].done = !state.modalSubs[idx].done;
      else state.modalSubs.splice(idx, 1);
      paintModalSubs();
    });

    // 快捷任务输入
    el.quickTaskInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var name = el.quickTaskInput.value.trim();
      if (!name) return;
      var task = S.findOrCreateTaskByName(name);
      S.saveNow();
      setCurrentTask(task.id, true);
      paintTagOptions();
      toast('开始专注：' + task.name);
      if (S.state.timer.phase !== 'focus') T.setPhase('focus');
      if (!S.state.timer.running) T.start();
      el.quickTaskInput.blur();
    });
    el.quickTaskInput.addEventListener('blur', function () {
      var cur = S.currentTask();
      el.quickTaskInput.value = cur ? cur.name : '';
    });

    // 任务列表
    el.taskList.addEventListener('click', function (e) {
      var item = e.target.closest('.task-item');
      if (!item) return;
      var id = item.dataset.id;
      var act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'toggle') {
        var t = S.getTask(id);
        if (t) { t.done = !t.done; S.saveNow(); paintTasks(); }
        return;
      }
      if (act && act.dataset.act === 'edit') { openTaskModal(id); return; }
      setCurrentTask(id);
    });

    // 环境音
    el.ambientGrid.addEventListener('click', function (e) {
      var b = e.target.closest('.ambient-item');
      if (b) setAmbient(b.dataset.ambient);
    });
    el.btnAmbientToggle.addEventListener('click', toggleAmbient);

    // 中断弹窗
    el.reasonGrid.addEventListener('click', function (e) {
      var b = e.target.closest('.reason-item');
      if (!b) return;
      state.pickedReason = b.dataset.reason;
      $$('.reason-item').forEach(function (x) { x.classList.toggle('is-active', x === b); });
    });
    el.btnBreakSave.addEventListener('click', saveBreakReason);
    el.btnBreakSkip.addEventListener('click', function () {
      var p = state.pendingInterrupt;
      if (p) {
        var recs = S.state.records;
        for (var i = recs.length - 1; i >= 0; i--) {
          if (recs[i].type === 'focus' && !recs[i].completed && !recs[i].reason) {
            recs[i].reason = '未记录';
            break;
          }
        }
        S.saveNow();
      }
      closeBreakModal();
    });

    // 设置项绑定
    bindSetting('setFocus', 'focus', 'number');
    bindSetting('setShort', 'short', 'number');
    bindSetting('setLong', 'long', 'number');
    bindSetting('setLongEvery', 'longEvery', 'number');
    bindSetting('setAutoBreak', 'autoStartBreak', 'checkbox');
    bindSetting('setAutoFocus', 'autoStartFocus', 'checkbox');
    bindSetting('setGoal', 'dailyGoal', 'number');
    bindSetting('setSound', 'soundOn', 'checkbox');
    bindSetting('setVolume', 'soundVolume', 'range');
    bindSetting('setTick', 'tickSound', 'checkbox');
    bindSetting('setNotify', 'notify', 'checkbox');
    bindSetting('setAmbientVolume', 'ambientVolume', 'range');
    bindSetting('setTray', 'showTrayCountdown', 'checkbox');
    bindSetting('setMinimize', 'minimizeToTray', 'checkbox');
    bindSetting('setOnTop', 'alwaysOnTop', 'checkbox');

    $$('#setTheme .seg-item').forEach(function (b) {
      b.addEventListener('click', function () {
        S.set({ settings: { theme: b.dataset.theme } });
        applyTheme();
        paintSettings();
      });
    });

    // 快捷键
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!el.taskModalScrim.hidden) return closeTaskModal();
        if (!el.breakModalScrim.hidden) return closeBreakModal();
        if (state.focusMode) return toggleFocusMode(false);
        if (el.drawer.classList.contains('is-open')) return closeSettings();
        return;
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!el.taskModalScrim.hidden || !el.breakModalScrim.hidden) return;

      var k = e.key.toLowerCase();
      if (e.code === 'Space') { e.preventDefault(); T.toggle(); ensureNotifyPermission(); return; }
      if (k === 'r') { e.preventDefault(); T.reset(); return; }
      if (k === 's') { e.preventDefault(); T.skip(); return; }
      if (k === 'f') { e.preventDefault(); toggleFocusMode(); return; }
      if (k === 't') { e.preventDefault(); setView(state.view === 'stats' ? 'timer' : 'stats'); return; }
      if (k === 'n') { e.preventDefault(); openTaskModal(null); return; }
      if (k === 'd') { e.preventDefault(); cycleTheme(); return; }
      if (k === ',') { e.preventDefault(); openSettings(); return; }
      if (k === '1') { e.preventDefault(); T.setPhase('focus'); return; }
      if (k === '2') { e.preventDefault(); T.setPhase('short'); return; }
      if (k === '3') { e.preventDefault(); T.setPhase('long'); return; }
    });

    // 系统主题变化
    if (mqlDark) {
      var handler = function () {
        if (S.state.settings.theme === 'auto') applyTheme();
      };
      if (mqlDark.addEventListener) mqlDark.addEventListener('change', handler);
      else if (mqlDark.addListener) mqlDark.addListener(handler);
    }

    // 回到前台时立刻校准
    doc.addEventListener('visibilitychange', function () {
      if (!doc.hidden) {
        T.check();
        paintTimer();
      }
    });

    // 快捷键提示
    doc.addEventListener('keypress', function () { Sound.unlock(); }, { once: true });
    doc.addEventListener('click', function () { Sound.unlock(); }, { once: true });
  }

  /* ============================================================ 启动 */

  function cacheDom() {
    [
      'timeDisplay', 'phaseLabel', 'ringProgress', 'cycleDots', 'cycleHint',
      'btnStart', 'btnReset', 'btnSkip', 'focusTime', 'focusPhase', 'focusStart',
      'focusReset', 'focusSkip', 'focusTask', 'focusOverlay', 'btnFocusMode',
      'todayCount', 'todayFocus', 'todayGoal',
      'btnTheme', 'btnSettings', 'scrim', 'drawer', 'btnCloseSettings',
      'taskList', 'taskEmpty', 'taskSummary', 'quickTaskInput', 'currentTaskMeta',
      'currentTaskChip', 'currentTaskPomos', 'btnAddTask', 'btnAmbientToggle', 'ambientGrid',
      'taskModalScrim', 'taskModalTitle', 'tmName', 'tmTag', 'tmEstimate', 'tmSubtasks',
      'tmSubInput', 'btnAddSub', 'btnSaveTask', 'btnCancelTask', 'btnDeleteTask',
      'btnCloseTaskModal', 'tagOptions',
      'breakModalScrim', 'breakModalText', 'reasonGrid', 'breakNote', 'btnBreakSave', 'btnBreakSkip',
      'statCards', 'trendChart', 'trendHint', 'taskChart', 'recordList', 'recordHint',
      'interruptList', 'interruptHint',
      'btnExportCsv', 'btnExportJson', 'btnImportJson', 'fileImport',
      'btnExportCsv2', 'btnExportJson2', 'btnSyncInfo', 'btnWipe',
      'storageInfo', 'dataInfo', 'toastWrap'
    ].forEach(function (id) { el[id] = $(id); });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('[sw] 注册失败', e);
      });
    });
  }

  function init() {
    cacheDom();
    S.load();
    applyTheme();
    paintTagOptions();
    paintTimer();
    paintToday();
    paintTasks();
    paintSettings();
    bindEvents();

    // 恢复环境音状态（需用户手势后才能播放，这里只同步 UI）
    if (S.state.settings.ambientPlaying && S.state.settings.ambient !== 'none') {
      var resume = function () {
        Sound.unlock();
        Sound.startAmbient(S.state.settings.ambient, S.state.settings.ambientVolume);
        doc.removeEventListener('click', resume);
        doc.removeEventListener('keydown', resume);
      };
      doc.addEventListener('click', resume);
      doc.addEventListener('keydown', resume);
    }

    T.restore();
    setView('timer');
    registerSW();

    // 每分钟刷新一次「今日」统计（跨零点）
    setInterval(function () {
      paintToday();
      if (state.view === 'stats') paintStats();
    }, 60000);

    // Electron 菜单指令
    if (global.pomodoroBridge && global.pomodoroBridge.onCommand) {
      global.pomodoroBridge.onCommand(function (cmd) {
        if (cmd === 'start') T.start();
        else if (cmd === 'pause') T.pause();
        else if (cmd === 'toggle') T.toggle();
        else if (cmd === 'skip') T.skip();
        else if (cmd === 'reset') T.reset();
        else if (cmd === 'focus') toggleFocusMode();
      });
    }

    if (global.pomodoroBridge && global.pomodoroBridge.setAlwaysOnTop) {
      global.pomodoroBridge.setAlwaysOnTop(!!S.state.settings.alwaysOnTop);
      global.pomodoroBridge.setMinimizeToTray(!!S.state.settings.minimizeToTray);
    }

    console.log('%c番茄钟已就绪', 'color:#FF6B5A;font-weight:600');
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
