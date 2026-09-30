/* ============================================================
   stats.js — 统计聚合与轻量 SVG 图表
   ============================================================ */
(function (global) {
  'use strict';

  var S = global.Store;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

  /* ---------------- 聚合 ---------------- */

  /**
   * @param {'day'|'week'|'month'} mode
   */
  function aggregate(mode) {
    var now = Date.now();
    var records = S.state.records;
    var from, to = now, series = [], rangeLabel = '';

    if (mode === 'day') {
      from = S.startOfDay(now);
      rangeLabel = '今天';
      var hours = new Array(24).fill(0);
      var hoursCount = new Array(24).fill(0);
      records.forEach(function (r) {
        if (r.type !== 'focus' || !r.completed) return;
        if (r.start < from || r.start > to) return;
        var h = new Date(r.start).getHours();
        hours[h] += r.seconds / 60;
        hoursCount[h] += 1;
      });
      for (var i = 0; i < 24; i++) {
        series.push({ label: i % 3 === 0 ? String(i) : '', value: Math.round(hours[i]), count: hoursCount[i], full: i + ':00' });
      }
    } else if (mode === 'week') {
      from = S.startOfWeek(now);
      rangeLabel = '本周';
      for (var d = 0; d < 7; d++) {
        var ts = S.addDays(from, d);
        series.push({ label: WEEK_CN[new Date(ts).getDay()], value: 0, count: 0, dayStart: ts });
      }
      records.forEach(function (r) {
        if (r.type !== 'focus' || !r.completed) return;
        if (r.start < from || r.start > to) return;
        var idx = Math.floor((S.startOfDay(r.start) - from) / 86400000);
        if (idx >= 0 && idx < 7) {
          series[idx].value += r.seconds / 60;
          series[idx].count += 1;
        }
      });
      series.forEach(function (s) { s.value = Math.round(s.value); });
    } else {
      from = S.startOfDay(S.addDays(now, -29));
      rangeLabel = '近 30 天';
      for (var k = 0; k < 30; k++) {
        var t2 = S.addDays(from, k);
        var dt = new Date(t2);
        series.push({
          label: (k % 5 === 0 || k === 29) ? (dt.getMonth() + 1) + '/' + dt.getDate() : '',
          value: 0, count: 0, dayStart: t2
        });
      }
      records.forEach(function (r) {
        if (r.type !== 'focus' || !r.completed) return;
        if (r.start < from || r.start > to) return;
        var idx2 = Math.floor((S.startOfDay(r.start) - from) / 86400000);
        if (idx2 >= 0 && idx2 < 30) {
          series[idx2].value += r.seconds / 60;
          series[idx2].count += 1;
        }
      });
      series.forEach(function (s) { s.value = Math.round(s.value); });
    }

    var inRange = records.filter(function (r) { return r.start >= from && r.start <= to; });
    var focusInRange = inRange.filter(function (r) { return r.type === 'focus' && r.completed; });
    var focusSeconds = focusInRange.reduce(function (a, r) { return a + r.seconds; }, 0);
    var interruptions = inRange.filter(function (r) { return r.type === 'focus' && !r.completed; });

    // 天数与目标达成
    var dayCount = mode === 'day' ? 1 : (mode === 'week' ? 7 : 30);
    var goal = S.state.settings.dailyGoal || 8;
    var byDay = {};
    focusInRange.forEach(function (r) {
      var k2 = S.dayKey(r.start);
      byDay[k2] = (byDay[k2] || 0) + 1;
    });
    var metDays = Object.keys(byDay).filter(function (k3) { return byDay[k3] >= goal; }).length;
    var activeDays = Object.keys(byDay).length;
    var goalRate = mode === 'day'
      ? Math.min(100, Math.round((byDay[S.dayKey(now)] || 0) / goal * 100))
      : (activeDays ? Math.round(metDays / activeDays * 100) : 0);

    // 任务分布
    var map = {};
    focusInRange.forEach(function (r) {
      var name = r.taskName || '未关联任务';
      if (!map[name]) map[name] = { name: name, count: 0, seconds: 0, tag: r.tag || '' };
      map[name].count += 1;
      map[name].seconds += r.seconds;
    });
    var byTask = Object.keys(map).map(function (k4) { return map[k4]; })
      .sort(function (a, b) { return b.count - a.count || b.seconds - a.seconds; });

    return {
      mode: mode,
      from: from,
      to: to,
      rangeLabel: rangeLabel,
      series: series,
      pomodoros: focusInRange.length,
      focusSeconds: focusSeconds,
      focusMinutes: Math.round(focusSeconds / 60),
      interruptions: interruptions,
      dayCount: dayCount,
      avgPerDay: +(focusInRange.length / dayCount).toFixed(1),
      goalRate: goalRate,
      goal: goal,
      byTask: byTask,
      activeDays: activeDays,
      recordsInRange: inRange.slice().sort(function (a, b) { return b.start - a.start; })
    };
  }

  /* ---------------- 柱状图 ---------------- */

  function barChart(series, color, opt) {
    opt = opt || {};
    var W = 620, H = opt.height || 210;
    var padT = 20, padB = 28, padL = 2, padR = 2;
    var n = series.length;
    if (!n) return '<div class="empty-hint">暂无数据</div>';

    var max = 0;
    series.forEach(function (s) { if (s.value > max) max = s.value; });
    if (max <= 0) {
      return '<div class="empty-hint" style="padding:44px 0">这个区间还没有专注记录</div>';
    }
    var top = Math.ceil(max / 5) * 5;
    if (top === max) top = max + 5;

    var innerW = W - padL - padR;
    var gap = n > 20 ? 3 : (n > 12 ? 6 : 10);
    var bw = Math.max(3, (innerW - gap * (n - 1)) / n);
    var innerH = H - padT - padB;

    var parts = [];
    parts.push('<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="专注趋势">');

    // 网格线
    [0, 0.5, 1].forEach(function (p) {
      var y = padT + innerH * (1 - p);
      parts.push('<line x1="0" y1="' + y.toFixed(1) + '" x2="' + W + '" y2="' + y.toFixed(1) +
        '" stroke="currentColor" stroke-opacity="0.08" stroke-width="1" stroke-dasharray="' + (p === 0 ? '0' : '4 6') + '"/>');
    });

    var showValue = n <= 14;
    series.forEach(function (s, i) {
      var x = padL + i * (bw + gap);
      var h = Math.max(s.value > 0 ? 3 : 0, innerH * (s.value / top));
      var y = padT + innerH - h;
      var r = Math.min(bw / 2, 6);
      if (h > 0) {
        parts.push('<rect class="bar-rect" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + h.toFixed(1) + '" rx="' + r.toFixed(1) + '" fill="' + color + '">' +
          '<title>' + esc(s.full || s.label || '') + '：' + s.value + ' 分钟 · ' + (s.count || 0) + ' 个番茄</title></rect>');
      } else {
        parts.push('<rect x="' + x.toFixed(1) + '" y="' + (padT + innerH - 2).toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="2" rx="1" fill="currentColor" fill-opacity="0.09"/>');
      }
      if (showValue && s.value > 0) {
        parts.push('<text class="chart-value" x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 6).toFixed(1) +
          '" text-anchor="middle">' + s.value + '</text>');
      }
      if (s.label) {
        parts.push('<text class="chart-label" x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 8) +
          '" text-anchor="middle">' + esc(s.label) + '</text>');
      }
    });

    parts.push('</svg>');
    return parts.join('');
  }

  /* ---------------- 任务分布 ---------------- */

  var PALETTE = ['#FF6B5A', '#6FC7B6', '#7FA8D8', '#E8B44C', '#B48AD8', '#5FB8C7', '#D88AA8'];

  function taskDistribution(byTask) {
    if (!byTask.length) {
      return '<div class="empty-hint" style="padding:40px 0">这个区间还没有已完成的番茄</div>';
    }
    var top = byTask.slice(0, 7);
    var max = top[0].count || 1;
    var total = byTask.reduce(function (a, t) { return a + t.count; }, 0);
    var rows = top.map(function (t, i) {
      var pct = Math.round(t.count / total * 100);
      var w = Math.max(6, Math.round(t.count / max * 100));
      return '<div class="dist-row">' +
        '<div class="dist-top"><span class="n">' + esc(t.name) + '</span>' +
        '<span class="c">' + t.count + ' 个 · ' + pct + '%</span></div>' +
        '<div class="dist-bar"><i style="width:' + w + '%;background:' + PALETTE[i % PALETTE.length] + '"></i></div>' +
        '</div>';
    }).join('');
    return '<div class="dist-list">' + rows + '</div>';
  }

  /* ---------------- 记录列表 ---------------- */

  var TYPE_META = {
    focus: { name: '专注', color: '#FF6B5A' },
    short: { name: '短休', color: '#6FC7B6' },
    long: { name: '长休', color: '#7FA8D8' }
  };

  function recordList(records, limit) {
    var list = records.slice(0, limit || 40);
    if (!list.length) return '<div class="empty-hint" style="padding:26px 0">暂无记录</div>';
    return list.map(function (r) {
      var m = TYPE_META[r.type] || TYPE_META.focus;
      var d = new Date(r.start);
      var dayLabel = S.dayKey(r.start) === S.dayKey(Date.now())
        ? '今天'
        : (d.getMonth() + 1) + '月' + d.getDate() + '日';
      var title = r.type === 'focus' ? (r.taskName || '未关联任务') : m.name;
      var detail = m.name + ' · ' + S.fmtDuration(r.seconds / 60);
      if (!r.completed && r.reason) detail += ' · ' + r.reason;
      if (!r.completed) title = (r.taskName || '未关联任务') + '（中断）';
      return '<li class="record-item">' +
        '<span class="record-dot" style="background:' + m.color + '"></span>' +
        '<div class="record-main"><span class="t">' + esc(title) + '</span>' +
        '<span class="s">' + esc(dayLabel + ' ' + S.fmtTimeHM(r.start) + ' · ' + detail) +
        (r.note ? ' · ' + esc(r.note) : '') + '</span></div>' +
        '<span class="record-time">' + Math.round(r.seconds / 60) + '′</span>' +
        '</li>';
    }).join('');
  }

  global.Stats = {
    aggregate: aggregate,
    barChart: barChart,
    taskDistribution: taskDistribution,
    recordList: recordList,
    esc: esc,
    palette: PALETTE,
    typeMeta: TYPE_META
  };
})(window);
