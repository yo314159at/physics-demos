/* Physics Playground: shared simulation toolkit (loaded by every demo, after site.js). Provides window.Sim.

   Core idea: a demo is a pure function of PARAMETERS and TIME, manipulated DIRECTLY on the stage.
     Sim.handles   draggable handles on the stage canvas (drag the velocity arrow, the block, a crest, a probe...).
                   Prefer these over sliders; sliders live in the settings dock as the precise, keyboard-friendly twin.
     Sim.timeline  computes the whole run (analytic `at(t)` or numeric `step`) and owns the clock:
                   play / pause / scrub / speed / loop. Changing a parameter -> tl.recompute() -> everything updates.
     Sim.graphDock the collapsible side menu that holds all graphs; each graph is toggled from its menu.
                   dock.timeGraph(tl, spec) / dock.graphCard(spec): playhead, hover tooltip, click-and-drag scrubbing,
                   gradient fill under each line, legend chips that toggle series.
   Extend this file only for helpers that at least two demos would reuse. */
(function () {
  'use strict';
  const Site = window.Site;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  /** Fixed-decimal formatting that never prints "-0.00". */
  const fmt = (x, d = 2) => { const s = Number(x).toFixed(d); return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s; };
  const decimalsOf = (step) => { const s = String(step); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
  const PALETTE = ['--c1', '--c2', '--c3', '--c4', '--c5'];
  /** Resolve a color spec ('--c2' theme variable, or any CSS color) to a concrete color string. */
  const resolve = (c) => (!c ? css('--c1') : (String(c).startsWith('--') ? css(c) : c));
  /** Add alpha to a #hex or rgb() color. */
  function alpha(c, a) {
    c = String(c).trim(); let m;
    if ((m = /^#([0-9a-f]{3})$/i.exec(c))) { const [r, g, b] = [...m[1]].map((h) => parseInt(h + h, 16)); return `rgba(${r},${g},${b},${a})`; }
    if ((m = /^#([0-9a-f]{6})$/i.exec(c))) { const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
    if ((m = /^rgba?\(([^)]+)\)/i.exec(c))) { const p = m[1].split(',').slice(0, 3).map((s) => s.trim()); return `rgba(${p.join(',')},${a})`; }
    return c;
  }
  const TAU = 2 * Math.PI;
  function setFill(input) {
    const min = +input.min || 0, max = +input.max || 100;
    input.style.setProperty('--p', ((+input.value - min) / (max - min || 1) * 100) + '%');
  }

  /* ---------- canvas: crisp on retina, drawn in CSS pixels, resizes with its container ----------
     No `aspect` (or fill:true): fills its parent completely (use for the stage; parent is position:relative).
     With `aspect`: width follows the parent, height = width / aspect (use for graphs). */
  function canvas(el, { aspect, fill, onResize } = {}) {
    const wrap = el.parentElement;
    const ctx = el.getContext('2d');
    const isFill = fill ?? !aspect;
    const api = { el, ctx, w: 0, h: 0, dpr: 1, clear() { ctx.clearRect(0, 0, api.w, api.h); } };
    function fit() {
      const r = wrap.getBoundingClientRect(), cs = getComputedStyle(wrap);
      const w = r.width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      const h = isFill ? r.height : Math.round(w / aspect);
      if (w < 10 || h < 10) return;                         // hidden (closed dock): refit when it is shown again
      if (api.w && Math.abs(w - api.w) < 0.5 && Math.abs(h - api.h) < 0.5) return;
      const dpr = window.devicePixelRatio || 1;
      el.style.width = w + 'px'; el.style.height = h + 'px';
      el.width = Math.round(w * dpr); el.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      Object.assign(api, { w, h, dpr });
      if (onResize) onResize(api);
    }
    if (window.ResizeObserver) new ResizeObserver(fit).observe(wrap);
    window.addEventListener('resize', fit);
    fit();
    return api;
  }

  /** Arrow from (x0,y0) to (x1,y1) in CSS pixels. */
  function arrow(ctx, x0, y0, x1, y1, { color = css('--c1'), width = 2.5, head = 10 } = {}) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
    if (L < 1e-6) return;
    const ux = dx / L, uy = dy / L, hs = Math.min(head, L * 0.6);
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - ux * hs * 0.8, y1 - uy * hs * 0.8); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - ux * hs - uy * hs * 0.5, y1 - uy * hs + ux * hs * 0.5);
    ctx.lineTo(x1 - ux * hs + uy * hs * 0.5, y1 - uy * hs - ux * hs * 0.5);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /** One classic RK4 step. f(t, y) -> dy/dt (arrays). Use for oscillators, orbits, anything with drag or coupling. */
  function rk4(f, y, t, dt) {
    const add = (a, b, s) => a.map((v, i) => v + b[i] * s);
    const k1 = f(t, y), k2 = f(t + dt / 2, add(y, k1, dt / 2)), k3 = f(t + dt / 2, add(y, k2, dt / 2)), k4 = f(t + dt, add(y, k3, dt));
    return y.map((v, i) => v + dt / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  }

  /* =====================================================================
     TIMELINE: the whole run is computed up front, so it can be scrubbed and graphed in full.
     Options:
       duration   seconds, or () => seconds (re-read on every recompute)
       at(t)      ANALYTIC mode: return the state at time t (any object)
       init(), step(state, dt, t) [, end(state, t)]   NUMERIC mode: step may mutate or return the new state;
                  dt (default 1/240), every (store every n-th step, default 1), end -> stop early (e.g. landed)
       draw(state, t)   render the stage; must not change physics
     API: t, duration, state(), samples [{t, s}], seek(t), play(), pause(), toggle(), recompute(),
          playing, speed, loop, onChange(fn(kind)) with kind 'time' | 'recompute' | 'theme', onPlay(fn)
     ===================================================================== */
  function timeline(o) {
    const numeric = typeof o.step === 'function';
    const dt0 = o.dt ?? 1 / 240, every = o.every ?? 1;
    const clone = o.snapshot || (typeof structuredClone === 'function' ? structuredClone : (x) => JSON.parse(JSON.stringify(x)));
    let samples = [], duration = 1, t = 0, playing = false, raf = 0, last = 0;
    const changeFns = [], playFns = [];
    const api = { speed: 1, loop: false };

    const state = () => numeric
      ? samples[Math.min(samples.length - 1, Math.round(t / (dt0 * every)))].s
      : o.at(t);
    function notify(kind) {
      if (o.draw) o.draw(state(), t);
      changeFns.forEach((fn) => fn(kind));
    }
    function recompute() {
      const D = Math.max(1e-6, typeof o.duration === 'function' ? o.duration() : (o.duration ?? 10));
      samples = [];
      if (numeric) {
        let st = o.init(), tt = 0;
        samples.push({ t: 0, s: clone(st) });
        const N = Math.round(D / dt0);
        for (let i = 1; i <= N; i++) {
          const r = o.step(st, dt0, tt); if (r !== undefined) st = r;
          tt = i * dt0;
          const done = o.end && o.end(st, tt);
          if (i % every === 0 || done || i === N) samples.push({ t: tt, s: clone(st) });
          if (done) break;
        }
        duration = samples[samples.length - 1].t || 1e-6;
      } else {
        duration = D;
        const N = o.samples ?? 600;
        for (let i = 0; i <= N; i++) { const tt = D * i / N; samples.push({ t: tt, s: o.at(tt) }); }
      }
      t = Math.min(t, duration);
      notify('recompute');
    }
    function frame(now) {
      if (!playing) return;
      t += Math.min(0.1, (now - last) / 1000) * api.speed; last = now;
      if (t >= duration) {
        if (api.loop) t = t % duration; else { t = duration; pause(); }
      }
      notify('time');
      if (playing) raf = requestAnimationFrame(frame);
    }
    function play() {
      if (playing) return;
      if (t >= duration) t = 0;
      playing = true; last = performance.now(); raf = requestAnimationFrame(frame);
      playFns.forEach((fn) => fn(true));
    }
    function pause() {
      if (!playing) return;
      playing = false; cancelAnimationFrame(raf);
      playFns.forEach((fn) => fn(false));
    }
    // NB: define getters with defineProperties: Object.assign would copy their current values and freeze them.
    Object.defineProperties(api, {
      t: { get: () => t }, duration: { get: () => duration }, playing: { get: () => playing }, samples: { get: () => samples }
    });
    Object.assign(api, {
      state, recompute, play, pause,
      toggle() { playing ? pause() : play(); },
      seek(x) { t = clamp(x, 0, duration); notify('time'); },
      redraw() { if (o.draw) o.draw(state(), t); },            // stage only (e.g. while a handle is hovered)
      onChange(fn) { changeFns.push(fn); },
      onPlay(fn) { playFns.push(fn); }
    });
    Site.onTheme(() => notify('theme'));
    recompute();
    return api;
  }

  /* =====================================================================
     GRAPHS
     ===================================================================== */
  function niceTicks(lo, hi, n = 4) {
    const raw = (hi - lo) / n || 1, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p, out = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return { ticks: out, step };
  }
  function valueAt(pts, x) {
    let lo = 0, hi = pts.length - 1;
    if (!pts.length) return NaN;
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[hi][0]) return pts[hi][1];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= x) lo = m; else hi = m; }
    const a = pts[lo], b = pts[hi];
    return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0] || 1);
  }

  /** Low-level graph on an existing <canvas>. Options:
        series:[{name, color:'--c2'|'#hex', data:()=>[[x,y],...] (x ascending), fill (default true), dash:[4,3], width, visible, unit}]
        xRange / yRange: [a,b] or () => [a,b];  yMin / yMax; symmetric (y axis centred on 0); includeZero (default true)
        cursor: () => x (playhead);  marker: () => [x,y];  onScrub(x): click/drag to scrub
        xLabel, yLabel, xName, xUnit, yUnit, aspect, xy (parametric plot: no fill, no tooltip)
      Returns {draw, canvas}. */
  function graph(el, o) {
    const body = el.parentElement;
    const tip = document.createElement('div'); tip.className = 'gtip'; tip.hidden = true; body.append(tip);
    let cv = null, hoverX = null, dragging = false, view = null;
    const xy = !!o.xy;
    const pad = { l: 50, r: 14, t: o.yLabel ? 24 : 12, b: o.xLabel ? 38 : 26 };
    cv = canvas(el, { aspect: o.aspect ?? 2.4, onResize: () => { if (cv) draw(); } });
    if (o.onScrub) el.style.touchAction = 'pan-y';

    function draw() {
      if (!cv || !cv.w || !el.offsetParent) return;           // not laid out / display:none
      const { ctx, w, h } = cv;
      ctx.clearRect(0, 0, w, h);
      const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
      const ser = o.series.map((s, i) => ({ s, i, c: resolve(s.color ?? PALETTE[i % PALETTE.length]), pts: s.data ? s.data() : [] }));
      const vis = ser.filter((q) => q.s.visible !== false && q.pts.length);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of vis) for (const p of q.pts) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      }
      if (!isFinite(x0)) { x0 = 0; x1 = 1; y0 = -1; y1 = 1; }
      const xr = typeof o.xRange === 'function' ? o.xRange() : o.xRange; if (xr) { x0 = xr[0]; x1 = xr[1]; }
      if (x1 - x0 < 1e-12) x1 = x0 + 1;
      const yr = typeof o.yRange === 'function' ? o.yRange() : o.yRange;
      if (yr) { y0 = yr[0]; y1 = yr[1]; } else {
        if (o.includeZero !== false) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
        if (o.symmetric) { const m = Math.max(Math.abs(y0), Math.abs(y1)); y0 = -m; y1 = m; }
        if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
        const span = y1 - y0; y1 += span * 0.06; if (y0 < 0 || o.includeZero === false) y0 -= span * 0.06;
      }
      if (o.yMin !== undefined) y0 = o.yMin;
      if (o.yMax !== undefined) y1 = o.yMax;
      const X = (x) => pad.l + (x - x0) / (x1 - x0) * iw, Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * ih;
      view = { x0, x1, iw, X, Y, ser, vis };

      const mono = `11px ${css('--mono')}`, muted = css('--muted'), grid = css('--sim-grid');
      ctx.font = mono; ctx.lineWidth = 1;
      const yt = niceTicks(y0, y1, 4), xt = niceTicks(x0, x1, 5);
      const dec = (st) => (st >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(st) - 1e-9)));
      ctx.fillStyle = muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      yt.ticks.forEach((v) => {
        const y = Y(v); ctx.strokeStyle = grid; ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
        ctx.fillText(v.toFixed(dec(yt.step)), pad.l - 8, y);
      });
      ctx.setLineDash([]); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      xt.ticks.forEach((v) => ctx.fillText(v.toFixed(dec(xt.step)), X(v), h - pad.b + 7));
      ctx.strokeStyle = css('--border-strong');
      ctx.beginPath(); ctx.moveTo(pad.l, pad.t + ih + 0.5); ctx.lineTo(w - pad.r, pad.t + ih + 0.5); ctx.stroke();
      if (y0 < 0 && y1 > 0) { ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(w - pad.r, Y(0)); ctx.stroke(); }
      if (o.yLabel) { ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(o.yLabel, pad.l - 38 > 2 ? 6 : 2, 13); }
      if (o.xLabel) { ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'; ctx.fillText(o.xLabel, w - pad.r, h - 4); }

      // series: gradient fill under each line (like a dashboard), then the line
      ctx.save(); ctx.beginPath(); ctx.rect(pad.l, pad.t - 2, iw, ih + 4); ctx.clip();
      for (const q of vis) {
        const { s, c, pts } = q;
        const path = () => { ctx.beginPath(); pts.forEach((p, k) => (k ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))); };
        if (s.fill !== false && !xy) {
          let ymin = Infinity, ymax = -Infinity; for (const p of pts) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
          const base = Y(clamp(0, y0, y1)), gTop = Math.min(Y(ymax), base), gBot = Math.max(Y(ymin), base);
          const b = gBot - gTop < 1 ? 1 : (base - gTop) / (gBot - gTop);
          const g = ctx.createLinearGradient(0, gTop, 0, gBot + (gBot - gTop < 1 ? 1 : 0));
          g.addColorStop(0, alpha(c, b <= 0 ? 0 : 0.28));
          if (b > 0 && b < 1) g.addColorStop(b, alpha(c, 0));
          g.addColorStop(1, alpha(c, b >= 1 ? 0 : 0.28));
          path(); ctx.lineTo(X(pts[pts.length - 1][0]), base); ctx.lineTo(X(pts[0][0]), base); ctx.closePath();
          ctx.fillStyle = g; ctx.fill();
        }
        path(); ctx.strokeStyle = c; ctx.lineWidth = s.width || 2; ctx.lineJoin = 'round'; ctx.setLineDash(s.dash || []); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.restore();

      // playhead, hover line, markers
      const dots = (x) => vis.forEach((q) => {
        const v = valueAt(q.pts, x); if (!isFinite(v)) return;
        ctx.beginPath(); ctx.arc(X(x), Y(v), 4, 0, 2 * Math.PI); ctx.fillStyle = css('--surface'); ctx.fill();
        ctx.strokeStyle = q.c; ctx.lineWidth = 2; ctx.stroke();
      });
      const vline = (x, col, dash) => {
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash(dash || []);
        ctx.beginPath(); ctx.moveTo(X(x), pad.t); ctx.lineTo(X(x), pad.t + ih); ctx.stroke(); ctx.setLineDash([]);
      };
      if (hoverX !== null && !xy) { vline(hoverX, css('--border-strong'), [3, 3]); dots(hoverX); }
      if (o.cursor && !xy) {
        const cx = o.cursor();
        if (cx !== null && cx !== undefined && isFinite(cx) && cx >= x0 - 1e-9 && cx <= x1 + 1e-9) { vline(cx, css('--text')); dots(cx); }
      }
      if (o.marker) {
        const m = o.marker();
        if (m && vis[0]) {
          ctx.beginPath(); ctx.arc(X(m[0]), Y(m[1]), 5, 0, 2 * Math.PI);
          ctx.fillStyle = vis[0].c; ctx.fill(); ctx.strokeStyle = css('--surface'); ctx.lineWidth = 2; ctx.stroke();
        }
      }
    }

    const xOf = (e) => {
      const r = el.getBoundingClientRect();
      return clamp(view.x0 + (e.clientX - r.left - pad.l) / view.iw * (view.x1 - view.x0), view.x0, view.x1);
    };
    function showTip(e) {
      if (!view) return;
      const x = hoverX, rows = view.vis.map((q) =>
        `<div><span class="dot" style="background:${q.c}"></span>${Site.esc(q.s.name)}: ${fmt(valueAt(q.pts, x), 3)}${(q.s.unit ?? o.yUnit) ? '\u00a0' + Site.esc(q.s.unit ?? o.yUnit) : ''}</div>`).join('');
      tip.innerHTML = `<div class="gx">${Site.esc(o.xName || 'x')} = ${fmt(x, 2)}${o.xUnit ? '\u00a0' + Site.esc(o.xUnit) : ''}</div>${rows}`;
      tip.hidden = false;
      const px = e.clientX - body.getBoundingClientRect().left;
      tip.style.left = clamp(px + 14, 4, body.clientWidth - tip.offsetWidth - 4) + 'px';
    }
    if (!xy) {
      el.addEventListener('pointermove', (e) => {
        if (!view) return;
        hoverX = xOf(e); showTip(e);
        if (dragging && o.onScrub) o.onScrub(hoverX); else draw();
      });
      el.addEventListener('pointerdown', (e) => {
        if (!o.onScrub || !view) return;
        dragging = true; el.setPointerCapture(e.pointerId); o.onScrub(xOf(e));
      });
      const up = () => { dragging = false; };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', () => { if (dragging) return; hoverX = null; tip.hidden = true; draw(); });
    }
    return { draw, canvas: cv };
  }

  /** A graph card (title + clickable legend + canvas). Takes the same options as graph() plus {title, visible:false}.
      Returns {card, graph, show(bool)}. Normally created through a graph dock (see graphDock). */
  function graphCard(container, o) {
    const card = document.createElement('section');
    card.className = 'card graph-card';
    card.innerHTML = '<header><h3></h3><div class="legend"></div></header><div class="graph-body"><canvas></canvas></div>';
    card.querySelector('h3').textContent = o.title || '';
    container.append(card);
    const g = graph(card.querySelector('canvas'), o);
    const legend = card.querySelector('.legend');
    o.series.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'legend-item'; b.setAttribute('aria-pressed', String(s.visible !== false));
      b.innerHTML = '<i class="dot"></i><span></span>'; b.querySelector('span').textContent = s.name;
      const col = s.color ?? PALETTE[i % PALETTE.length];
      b.style.setProperty('--dot', String(col).startsWith('--') ? `var(${col})` : col);
      b.addEventListener('click', () => { s.visible = s.visible === false; b.setAttribute('aria-pressed', String(s.visible !== false)); g.draw(); });
      legend.append(b);
    });
    if (o.visible === false) card.hidden = true;
    Site.onTheme(g.draw);
    return { card, graph: g, show(on) { card.hidden = !on; if (on) g.draw(); } };
  }

  /** The side menu that holds every graph. Put <aside class="dock right" data-dock="graphs" data-label="Graphs"
      data-icon="ph-chart-line-up" data-open="true"> in the page, then:
        const dock = Sim.graphDock(el);  dock.timeGraph(tl, spec);  dock.graphCard(spec);
      A chip per graph in the menu shows/hides it. The first `visibleCount` (default 2) start visible unless
      spec.visible says otherwise. Give each spec a `short` menu label and optionally an `icon` (Phosphor class). */
  function graphDock(el, { visibleCount = 2 } = {}) {
    el.innerHTML = '<div class="dock-head"><h3>Graphs</h3></div><div class="graph-menu" role="group" aria-label="Choose graphs"></div><div class="graph-list"></div>';
    const menu = el.querySelector('.graph-menu'), list = el.querySelector('.graph-list'), entries = [];
    const empty = document.createElement('div'); empty.className = 'graph-empty'; empty.textContent = 'Pick a graph above.'; list.append(empty);
    const sync = () => { empty.hidden = entries.some((e) => e.getAttribute('aria-pressed') === 'true'); };
    function register(res, spec) {
      const on = spec.visible ?? entries.length < visibleCount;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.setAttribute('aria-pressed', String(on));
      b.innerHTML = `<i class="ph ${Site.esc(spec.icon || 'ph-chart-line')}"></i><span></span>`;
      b.querySelector('span').textContent = spec.short || spec.title;
      b.addEventListener('click', () => { const now = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(now)); res.show(now); sync(); });
      menu.append(b); entries.push(b); res.show(on); sync();
      return res;
    }
    return {
      el,
      timeGraph: (tl, spec) => register(timeGraph(list, tl, { ...spec, visible: true }), spec),
      graphCard: (spec) => register(graphCard(list, { ...spec, visible: true }), spec)
    };
  }

  /** Graph of a timeline's whole run. spec: {title, series:[{name, color, y:(state,t)=>number, x:(state,t)=>number (xy only), unit, fill, dash, visible}],
        xy:true for a parametric plot (e.g. y vs x, phase portrait: playhead becomes a dot), yLabel, yUnit, xLabel, symmetric, yMin, yMax, visible:false, aspect}
      Time graphs get a playhead, hover tooltip and click/drag scrubbing for free. */
  function timeGraph(container, tl, spec) {
    const xy = !!spec.xy, cache = [], MAXPTS = 700;
    const build = () => {
      const S = tl.samples, stride = Math.max(1, Math.ceil(S.length / MAXPTS));
      spec.series.forEach((s, i) => {
        const out = [];
        for (let j = 0; j < S.length; j += stride) out.push([xy ? s.x(S[j].s, S[j].t) : S[j].t, s.y(S[j].s, S[j].t)]);
        const L = S[S.length - 1]; if ((S.length - 1) % stride) out.push([xy ? s.x(L.s, L.t) : L.t, s.y(L.s, L.t)]);
        cache[i] = out;
      });
    };
    build();
    const series = spec.series.map((s, i) => ({ ...s, data: () => cache[i] || [] }));
    const res = graphCard(container, {
      aspect: 2.4, ...spec, series,
      xRange: xy ? spec.xRange : () => [0, tl.duration],
      cursor: xy ? null : () => tl.t,
      marker: xy ? () => { const st = tl.state(); return [spec.series[0].x(st, tl.t), spec.series[0].y(st, tl.t)]; } : null,
      onScrub: xy ? null : (x) => { tl.pause(); tl.seek(x); },
      xName: spec.xName ?? 't', xUnit: spec.xUnit ?? 's', xLabel: spec.xLabel ?? (xy ? '' : 'time (s)')
    });
    tl.onChange((kind) => { if (kind === 'recompute') build(); res.graph.draw(); });
    res.graph.draw();
    return res;
  }

  /* ---------- controls: sliders, toggles, selects, buttons, section headings ---------- */
  /** specs: [{type:'heading', label}, {type:'slider', id, label, min, max, step, value, unit, decimals},
              {type:'toggle', id, label, value}, {type:'select', id, label, value, options:[{value,label}]},
              {type:'button', id, label, onClick}]
      onChange(values, changedId) fires on user input. Returns {values, set(id, v), setEnabled(id, bool)}. */
  function controls(container, specs, onChange) {
    const values = {}, setters = {}, wraps = {}, inputs = {};
    specs.forEach((s) => {
      if (s.type === 'heading') {
        const h = document.createElement('div'); h.className = 'ctl-heading'; h.textContent = s.label; container.append(h); return;
      }
      const wrap = document.createElement('div');
      wrap.className = 'ctl ctl-' + s.type;
      const uid = 'ctl-' + s.id + '-' + Math.random().toString(36).slice(2, 6);
      if (s.type === 'slider') {
        wrap.innerHTML = `<label for="${uid}"><span class="ctl-label"></span><output for="${uid}"></output></label><input type="range" id="${uid}">`;
        const input = wrap.querySelector('input'), out = wrap.querySelector('output');
        const d = s.decimals ?? (s.step ? decimalsOf(s.step) : 2);
        Object.assign(input, { min: s.min, max: s.max, step: s.step ?? 'any', value: s.value });
        const show = () => { out.textContent = fmt(values[s.id], d) + (s.unit ? (/^[°%]/.test(s.unit) ? '' : '\u00a0') + s.unit : ''); setFill(input); };
        values[s.id] = +input.value; show();
        input.addEventListener('input', () => { values[s.id] = +input.value; show(); if (onChange) onChange(values, s.id); });
        setters[s.id] = (v) => { input.value = v; values[s.id] = +input.value; show(); };
        inputs[s.id] = input;
      } else if (s.type === 'toggle') {
        wrap.innerHTML = '<label class="toggle"><span class="switch"><input type="checkbox"></span><span class="ctl-label"></span></label>';
        const input = wrap.querySelector('input');
        input.checked = !!s.value; values[s.id] = input.checked;
        input.addEventListener('change', () => { values[s.id] = input.checked; if (onChange) onChange(values, s.id); });
        setters[s.id] = (v) => { input.checked = !!v; values[s.id] = !!v; };
        inputs[s.id] = input;
      } else if (s.type === 'select') {
        wrap.innerHTML = `<label for="${uid}"><span class="ctl-label"></span></label><select id="${uid}"></select>`;
        const sel = wrap.querySelector('select');
        s.options.forEach((op) => { const e = document.createElement('option'); e.value = op.value; e.textContent = op.label; sel.append(e); });
        sel.value = s.value; values[s.id] = sel.value;
        sel.addEventListener('change', () => { values[s.id] = sel.value; if (onChange) onChange(values, s.id); });
        setters[s.id] = (v) => { sel.value = v; values[s.id] = sel.value; };
        inputs[s.id] = sel;
      } else if (s.type === 'button') {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn'; b.textContent = s.label;
        b.addEventListener('click', () => s.onClick && s.onClick(values)); wrap.append(b);
      }
      const lab = wrap.querySelector('.ctl-label'); if (lab) lab.textContent = s.label;
      wraps[s.id] = wrap;
      container.append(wrap);
    });
    return {
      values,
      set(id, v) { if (setters[id]) setters[id](v); },
      setEnabled(id, on) { if (wraps[id]) { wraps[id].classList.toggle('disabled', !on); inputs[id].disabled = !on; } }
    };
  }

  /* ---------- live numeric readouts ---------- */
  /** specs: [{id, label}] -> {set(id, text)}. Pass already-formatted text, e.g. r.set('t', Sim.fmt(t) + ' s'). */
  function readouts(container, specs) {
    container.classList.add('readouts');
    const vals = {};
    specs.forEach((s) => {
      const d = document.createElement('div');
      d.className = 'readout';
      d.innerHTML = '<span class="r-label"></span><span class="r-value">–</span>';
      d.querySelector('.r-label').textContent = s.label;
      vals[s.id] = d.querySelector('.r-value');
      container.append(d);
    });
    return { set(id, txt) { if (vals[id]) vals[id].textContent = txt; } };
  }

  /* ---------- play / restart / TIMELINE SCRUBBER / time / speed / loop ---------- */
  /** Keys: Space play/pause, ←/→ step 1% (Shift: 10%), R or Home restart. */
  function playbar(container, tl, { speeds = [0.25, 0.5, 1, 2] } = {}) {
    container.classList.add('playbar');
    container.innerHTML =
      '<button type="button" class="btn primary icon" data-r="play"></button>' +
      '<button type="button" class="btn icon" data-r="restart" aria-label="Restart (R)" title="Restart (R)"><i class="ph ph-arrow-counter-clockwise"></i></button>' +
      '<input class="scrub" type="range" min="0" max="1000" step="1" value="0" aria-label="Timeline">' +
      '<span class="tlabel"></span>' +
      '<select aria-label="Playback speed" title="Playback speed"></select>' +
      '<button type="button" class="btn icon" data-r="loop" aria-label="Loop" title="Loop" aria-pressed="false"><i class="ph ph-repeat"></i></button>';
    const play = container.querySelector('[data-r=play]'), restart = container.querySelector('[data-r=restart]');
    const loop = container.querySelector('[data-r=loop]'), scrub = container.querySelector('.scrub');
    const label = container.querySelector('.tlabel'), sel = container.querySelector('select');
    speeds.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = '×' + v; sel.append(o); });
    sel.value = String(tl.speed);
    const sync = () => {
      play.innerHTML = `<i class="ph-fill ph-${tl.playing ? 'pause' : 'play'}"></i>`;
      play.setAttribute('aria-label', tl.playing ? 'Pause (Space)' : 'Play (Space)'); play.title = play.getAttribute('aria-label');
      scrub.value = 1000 * tl.t / tl.duration; setFill(scrub);
      label.textContent = `${fmt(tl.t, 2)} / ${fmt(tl.duration, 2)} s`;
    };
    play.addEventListener('click', () => tl.toggle());
    restart.addEventListener('click', () => { tl.pause(); tl.seek(0); });
    scrub.addEventListener('input', () => { tl.pause(); tl.seek(+scrub.value / 1000 * tl.duration); });
    sel.addEventListener('change', () => { tl.speed = +sel.value; });
    loop.addEventListener('click', () => { tl.loop = !tl.loop; loop.setAttribute('aria-pressed', String(tl.loop)); });
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
      const tag = e.target.tagName, typing = /^(INPUT|SELECT|TEXTAREA)$/.test(tag);
      if (e.code === 'Space' && !typing && tag !== 'BUTTON') { e.preventDefault(); tl.toggle(); }
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !typing) {
        e.preventDefault(); tl.pause(); tl.seek(tl.t + (e.key === 'ArrowRight' ? 1 : -1) * tl.duration * (e.shiftKey ? 0.1 : 0.01));
      } else if ((e.key === 'r' || e.key === 'R' || e.key === 'Home') && !typing) { tl.pause(); tl.seek(0); }
    });
    tl.onChange(sync); tl.onPlay(sync); sync();
    return { play, restart, scrub };
  }

  /* ---------- stage tools: segmented choices and toggle buttons floating on the stage (e.g. Earth | Moon | Mars) ---------- */
  /** items: [{type:'segment', label, options:[{value,label,icon?}], value:()=>v, onChange(v)},
              {type:'toggle', icon:'ph-wave-sine', label, active:()=>bool, onClick()}]  -> {refresh()} */
  function toolbar(container, items) {
    const syncs = [];
    const sync = () => syncs.forEach((f) => f());
    items.forEach((it) => {
      if (it.type === 'segment') {
        const seg = document.createElement('div'); seg.className = 'seg'; seg.setAttribute('role', 'group');
        if (it.label) seg.setAttribute('aria-label', it.label);
        it.options.forEach((o) => {
          const b = document.createElement('button'); b.type = 'button';
          b.innerHTML = (o.icon ? `<i class="ph ${Site.esc(o.icon)}"></i>` : '') + `<span>${Site.esc(o.label)}</span>`;
          b.addEventListener('click', () => { it.onChange(o.value); sync(); });
          seg.append(b);
        });
        container.append(seg);
        syncs.push(() => [...seg.children].forEach((b, i) => b.setAttribute('aria-pressed', String(it.options[i].value === it.value()))));
      } else {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn';
        b.innerHTML = `<i class="ph ${Site.esc(it.icon || 'ph-circle')}"></i><span>${Site.esc(it.label)}</span>`; b.title = it.title || it.label;
        b.addEventListener('click', () => { it.onClick(); sync(); });
        container.append(b);
        if (it.active) syncs.push(() => b.setAttribute('aria-pressed', String(!!it.active())));
      }
    });
    sync();
    return { refresh: sync };
  }

  /* ---------- DIRECT MANIPULATION: draggable handles on the stage ----------
     list: [{id, pos: () => [x, y] (CSS px), onDrag(x, y, event), onStart?, onEnd?(event), color:'--c1', radius:13,
             label: () => 'text' (shown while hovered/dragged; showLabel:true keeps it visible), hidden: () => bool}]
     redraw: function that repaints the stage (pass () => tl.redraw()).
     Call handles.draw(ctx) LAST in the stage's draw(). Hover grows a handle and shows a hand cursor; dragging grows it
     more with a glow, so the stage feels alive. Positions are in canvas pixels, so keep handle geometry independent of
     auto-fit world scales (otherwise the handle moves under the cursor while you drag it). */
  function handles(cv, list, { redraw } = {}) {
    const el = cv.el;
    let active = null, hover = null, raf = 0;
    list.forEach((h) => { h.s = 1; h.radius = h.radius ?? 13; });
    const shown = (h) => !(h.hidden && h.hidden());
    const local = (e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const hit = (x, y) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const h = list[i]; if (!shown(h)) continue;
        const p = h.pos(); if (Math.hypot(x - p[0], y - p[1]) <= h.radius + 7) return h;
      }
      return null;
    };
    function animate() {
      if (raf) return;
      const tick = () => {
        raf = 0; let moving = false;
        list.forEach((h) => {
          const target = h === active ? 1.45 : h === hover ? 1.22 : 1;
          h.s += (target - h.s) * 0.35;
          if (Math.abs(target - h.s) > 0.01) moving = true; else h.s = target;
        });
        if (redraw) redraw();
        if (moving) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    el.addEventListener('pointerdown', (e) => {
      const [x, y] = local(e), h = hit(x, y); if (!h) return;
      active = h; el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing';
      if (h.onStart) h.onStart(x, y, e);
      h.onDrag(x, y, e); e.preventDefault(); animate();
    });
    el.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      if (active) { active.onDrag(x, y, e); return; }
      const h = hit(x, y);
      if (h !== hover) { hover = h; el.style.cursor = h ? 'grab' : ''; animate(); }
    });
    const end = (e) => {
      if (!active) return;
      const h = active; active = null; el.style.cursor = hover ? 'grab' : '';
      if (h.onEnd) h.onEnd(e);
      animate();
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { if (!active && hover) { hover = null; el.style.cursor = ''; animate(); } });

    function draw(ctx) {
      list.forEach((h) => {
        if (!shown(h)) return;
        const [x, y] = h.pos(), col = resolve(h.color ?? '--c1'), r = h.radius * h.s;
        ctx.save();
        ctx.beginPath(); ctx.arc(x, y, r + (h === active ? 11 : h === hover ? 7 : 3), 0, TAU);
        ctx.fillStyle = alpha(col, h === active ? 0.3 : h === hover ? 0.22 : 0.12); ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = css('--surface'); ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, r * 0.36, 0, TAU); ctx.fillStyle = col; ctx.fill();
        const text = h.label ? h.label() : null;
        if (text && (h === active || h === hover || h.showLabel)) {
          ctx.font = `600 14px ${css('--mono')}`;
          const tw = ctx.measureText(text).width, bw = tw + 18, bh = 26;
          let bx = x - bw / 2, by = y - r - 16 - bh;
          if (by < 4) by = y + r + 16;
          bx = clamp(bx, 4, cv.w - bw - 4);
          ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 7); else ctx.rect(bx, by, bw, bh);
          ctx.fillStyle = css('--surface'); ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = col; ctx.stroke();
          ctx.fillStyle = css('--text'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + bw / 2, by + bh / 2 + 1);
        }
        ctx.restore();
      });
    }
    return { draw, get active() { return active; }, get hover() { return hover; } };
  }
  /** Snap v to the nearest multiple of `step` when within `tol` (detents make dragging feel precise). */
  const snap = (v, step, tol) => { const n = Math.round(v / step) * step; return Math.abs(v - n) <= tol ? n : v; };

  /* ---------- free-running loop: ONLY for sims that cannot be precomputed (live user interaction mid-run) ---------- */
  function loop({ step, draw, dt = 1 / 240, reset }) {
    let running = false, last = 0, acc = 0, raf = 0, time = 0, speed = 1;
    const stateListeners = [];
    const emit = () => stateListeners.forEach((fn) => fn(running));
    function frame(now) {
      if (!running) return;
      acc += Math.min(0.1, (now - last) / 1000) * speed; last = now;
      let n = 0;
      while (acc >= dt && running && n < 4000) { step(dt, time); time += dt; acc -= dt; n++; }
      if (n >= 4000) acc = 0;
      draw(acc / dt);
      if (running) raf = requestAnimationFrame(frame);
    }
    const api = {
      get running() { return running; }, get time() { return time; },
      get speed() { return speed; }, set speed(v) { speed = v; },
      start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); emit(); },
      stop() { if (!running) return; running = false; cancelAnimationFrame(raf); emit(); },
      toggle() { running ? api.stop() : api.start(); },
      reset() { time = 0; acc = 0; if (reset) reset(); draw(0); },
      redraw() { draw(0); },
      onState(fn) { stateListeners.push(fn); }
    };
    Site.onTheme(api.redraw);
    draw(0);
    return api;
  }

  window.Sim = { css, resolve, alpha, clamp, lerp, fmt, snap, TAU, canvas, arrow, rk4, timeline, graph, graphCard, timeGraph, graphDock, controls, readouts, playbar, toolbar, handles, loop };
})();
