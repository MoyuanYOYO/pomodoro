/* ============================================================
   audio.js — Web Audio 合成提示音与环境音（无需任何音频素材）
   ============================================================ */
(function (global) {
  'use strict';

  var ctx = null;
  var master = null;
  var ambient = null;
  var noiseBuffer = null;

  function ensure() {
    if (ctx) {
      resumeQuietly(ctx);
      return ctx;
    }
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch (e) {
      console.warn('[audio] 音频上下文不可用', e);
      return null;
    }
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    return ctx;
  }

  /** resume() 在部分环境会 reject，静默吞掉，避免未处理的 Promise 异常 */
  function resumeQuietly(c) {
    if (!c || c.state !== 'suspended') return;
    try {
      var p = c.resume();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) { /* noop */ }
  }

  function unlock() {
    var c = ensure();
    if (!c) return;
    resumeQuietly(c);
    // iOS/Safari 需要一次空播放解锁
    try {
      var b = c.createBuffer(1, 1, 22050);
      var s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
    } catch (e) { /* noop */ }
  }

  /* ---------------- 提示音 ---------------- */

  /**
   * 弹奏一组音（钟琴音色：基频 + 泛音，指数衰减）
   */
  function chime(freqs, opt) {
    var c = ensure();
    if (!c) return;
    opt = opt || {};
    var dur = opt.duration || 1.6;
    var gainVal = (opt.gain == null ? 0.5 : opt.gain);
    var step = opt.step == null ? 0.13 : opt.step;
    var t0 = c.currentTime + 0.02;

    var out = c.createGain();
    out.gain.value = gainVal;
    out.connect(master);

    // 轻微混响感：一个短延迟反馈
    var delay = c.createDelay(0.4);
    delay.delayTime.value = 0.11;
    var fb = c.createGain();
    fb.gain.value = 0.22;
    var wet = c.createGain();
    wet.gain.value = 0.3;
    delay.connect(fb); fb.connect(delay);
    delay.connect(wet); wet.connect(master);
    out.connect(delay);

    freqs.forEach(function (f, i) {
      var start = t0 + i * step;
      [1, 2.0, 2.76, 5.4].forEach(function (mult, k) {
        var osc = c.createOscillator();
        var g = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = f * mult;
        var partialGain = [1, 0.28, 0.16, 0.06][k];
        var level = partialGain * 0.34;
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(level, start + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur * (k === 0 ? 1 : 0.55));
        osc.connect(g);
        g.connect(out);
        osc.start(start);
        osc.stop(start + dur + 0.1);
      });
    });
  }

  function play(kind) {
    switch (kind) {
      case 'focusEnd':   // 专注结束 → 进入休息：柔和下行两音
        chime([783.99, 587.33], { duration: 2.0, gain: 0.55, step: 0.16 });
        break;
      case 'breakEnd':   // 休息结束 → 回到专注：上行三音，提醒感更强
        chime([523.25, 659.25, 783.99], { duration: 1.5, gain: 0.6, step: 0.12 });
        break;
      case 'start':
        chime([659.25], { duration: 0.7, gain: 0.3 });
        break;
      case 'skip':
        chime([440, 349.23], { duration: 0.6, gain: 0.28, step: 0.08 });
        break;
      case 'goal':       // 达成每日目标
        chime([523.25, 659.25, 783.99, 1046.5], { duration: 1.8, gain: 0.6, step: 0.11 });
        break;
      case 'tick': {
        var c = ensure();
        if (!c) return;
        var osc = c.createOscillator();
        var g = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = 1500;
        g.gain.setValueAtTime(0.0001, c.currentTime);
        g.gain.linearRampToValueAtTime(0.14, c.currentTime + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.07);
        osc.connect(g); g.connect(master);
        osc.start();
        osc.stop(c.currentTime + 0.1);
        break;
      }
      default: break;
    }
  }

  /* ---------------- 环境音 ---------------- */

  function getNoiseBuffer(c, kind) {
    if (noiseBuffer && noiseBuffer.kind === kind) return noiseBuffer.buffer;
    var len = c.sampleRate * 4;
    var buf = c.createBuffer(1, len, c.sampleRate);
    var data = buf.getChannelData(0);
    if (kind === 'brown') {
      var last = 0;
      for (var i = 0; i < len; i++) {
        var w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        data[i] = last * 3.2;
      }
    } else {
      for (var j = 0; j < len; j++) data[j] = Math.random() * 2 - 1;
    }
    noiseBuffer = { kind: kind, buffer: buf };
    return buf;
  }

  function lfo(c, freq, depth, target, base) {
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.value = depth;
    target.value = base;
    osc.connect(g);
    g.connect(target);
    osc.start();
    return osc;
  }

  function stopAmbient() {
    if (!ambient) return;
    var c = ctx;
    var nodes = ambient;
    ambient = null;
    try {
      if (c && nodes.out) {
        var now = c.currentTime;
        nodes.out.gain.cancelScheduledValues(now);
        nodes.out.gain.setValueAtTime(nodes.out.gain.value, now);
        nodes.out.gain.linearRampToValueAtTime(0.0001, now + 0.5);
      }
      setTimeout(function () {
        nodes.sources.forEach(function (s) { try { s.stop(); } catch (e) {} });
      }, 560);
    } catch (e) { /* noop */ }
  }

  function startAmbient(kind, volume) {
    stopAmbient();
    var c = ensure();
    if (!c || !kind || kind === 'none') return;

    var out = c.createGain();
    out.gain.value = 0.0001;
    out.connect(master);

    var sources = [];
    var src;

    function noise(kindName) {
      src = c.createBufferSource();
      src.buffer = getNoiseBuffer(c, kindName);
      src.loop = true;
      src.start();
      sources.push(src);
      return src;
    }

    if (kind === 'white') {
      var s1 = noise('white');
      var lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 7200; lp.Q.value = 0.4;
      var hp = c.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 120; hp.Q.value = 0.4;
      s1.connect(lp); lp.connect(hp); hp.connect(out);
      sources.push(lfo(c, 0.07, 500, lp.frequency, 7200));

    } else if (kind === 'brown') {
      var s2 = noise('brown');
      var lp2 = c.createBiquadFilter();
      lp2.type = 'lowpass'; lp2.frequency.value = 1400; lp2.Q.value = 0.5;
      s2.connect(lp2); lp2.connect(out);

    } else if (kind === 'rain') {
      var s3 = noise('white');
      var lp3 = c.createBiquadFilter();
      lp3.type = 'lowpass'; lp3.frequency.value = 2600; lp3.Q.value = 0.7;
      var hp3 = c.createBiquadFilter();
      hp3.type = 'highpass'; hp3.frequency.value = 420; hp3.Q.value = 0.5;
      var sh = c.createGain(); sh.gain.value = 1;
      s3.connect(lp3); lp3.connect(hp3); hp3.connect(sh); sh.connect(out);
      sources.push(lfo(c, 0.11, 0.16, sh.gain, 1));
      sources.push(lfo(c, 0.05, 900, lp3.frequency, 2600));

    } else if (kind === 'cafe') {
      var s4 = noise('brown');
      var bp = c.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 620; bp.Q.value = 0.55;
      var g4 = c.createGain(); g4.gain.value = 1.1;
      s4.connect(bp); bp.connect(g4); g4.connect(out);
      var s5 = noise('white');
      var lp5 = c.createBiquadFilter();
      lp5.type = 'lowpass'; lp5.frequency.value = 900; lp5.Q.value = 0.6;
      var g5 = c.createGain(); g5.gain.value = 0.16;
      s5.connect(lp5); lp5.connect(g5); g5.connect(out);
      sources.push(lfo(c, 0.23, 0.22, g5.gain, 0.16));

    } else if (kind === 'waves') {
      var s6 = noise('brown');
      var lp6 = c.createBiquadFilter();
      lp6.type = 'lowpass'; lp6.frequency.value = 700; lp6.Q.value = 0.9;
      var g6 = c.createGain(); g6.gain.value = 1;
      s6.connect(lp6); lp6.connect(g6); g6.connect(out);
      sources.push(lfo(c, 0.085, 420, lp6.frequency, 700));
      sources.push(lfo(c, 0.085, 0.42, g6.gain, 1));
    }

    ambient = { kind: kind, out: out, sources: sources };
    var now = c.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(Math.max(0.0002, volume), now + 1.1);
  }

  function setAmbientVolume(v) {
    if (!ambient || !ctx) return;
    ambient.out.gain.linearRampToValueAtTime(Math.max(0.0002, v), ctx.currentTime + 0.2);
  }

  global.Sound = {
    unlock: unlock,
    ensure: ensure,
    play: play,
    startAmbient: startAmbient,
    stopAmbient: stopAmbient,
    setAmbientVolume: setAmbientVolume,
    get ambientKind() { return ambient ? ambient.kind : 'none'; },
    get isAmbientPlaying() { return !!ambient; }
  };
})(window);
