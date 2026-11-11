'use strict';
// Колесо: появляется на время прокрутки, докручивается до варианта, выбранного ядром заранее, показывает итог и прячется.
const stage = document.getElementById('stage');
const wrap = document.getElementById('wrap');
const res = document.getElementById('res');
const NS = 'http://www.w3.org/2000/svg';
const PAL = {
  general: ['#7b6cf0', '#3fa9e0', '#5b4fc4', '#2f86b8', '#9688ff', '#4cc0d9'],
  campfire: ['#e0303e', '#8a3bc4', '#2f62e0', '#b8344f', '#6236a8', '#2a4fb8']
};
let cfg = null;
let w = null;
let offset = 0;
let theme = 'general';
let spinId = '';
let shownSpin = null; // геометрия последней прокрутки — чтобы после остановки колесо стояло на итоге
let finalAngle = 0;
let rot = null;
let hideTimer = null;
let raf = 0;

const now = () => Date.now() + offset;
const sv = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};
const pt = (deg, r) => [r * Math.sin((deg * Math.PI) / 180), -r * Math.cos((deg * Math.PI) / 180)];
const short = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

function colors(n) {
  const pal = PAL[theme] || PAL.general;
  const out = [];
  for (let i = 0; i < n; i++) out.push(pal[i % pal.length]);
  // Соседи по кругу (последний и первый) не должны совпасть.
  if (n > 3 && out[n - 1] === out[0]) out[n - 1] = pal[2];
  return out;
}

/** Угол поворота, при котором стрелка (сверху) встанет в точку offset сектора target. */
function targetAngle(sp) {
  let a0 = 0;
  for (const s of sp.sectors) {
    if (s.id === sp.targetId) return sp.turns * 360 - (a0 + s.frac * 360 * sp.offset);
    a0 += s.frac * 360;
  }
  return sp.turns * 360;
}

function build(sp) {
  const svg = sv('svg', { viewBox: '-112 -116 224 228' });
  rot = sv('g', {});
  const cols = colors(sp.sectors.length);
  let a0 = 0;
  sp.sectors.forEach((s, i) => {
    const span = s.frac * 360;
    let seg;
    if (span >= 359.99) seg = sv('circle', { r: 100, cx: 0, cy: 0 });
    else {
      const [x0, y0] = pt(a0, 100), [x1, y1] = pt(a0 + span, 100);
      seg = sv('path', { d: `M0 0 L${x0.toFixed(2)} ${y0.toFixed(2)} A100 100 0 ${span > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z` });
    }
    seg.setAttribute('fill', cols[i]);
    seg.setAttribute('stroke', 'rgba(0,0,0,.25)');
    seg.setAttribute('stroke-width', '.6');
    seg.dataset.id = s.id;
    rot.append(seg);
    if (span >= 6) {
      const mid = a0 + span / 2;
      const size = Math.max(3.2, Math.min(7.5, span * 0.33));
      const t = sv('text', { class: 'lbl', transform: `rotate(${(mid - 90).toFixed(2)}) translate(92 0)`, 'text-anchor': 'end', 'dominant-baseline': 'middle', 'font-size': size.toFixed(2) });
      // Сколько букв влезет от края до центральной втулки при этом размере шрифта.
      t.textContent = short(s.name, Math.max(6, Math.floor(76 / (size * 0.58))));
      rot.append(t);
    }
    a0 += span;
  });
  svg.append(rot, sv('circle', { class: 'rim', r: 100.5, cx: 0, cy: 0 }), sv('circle', { class: 'hub', r: 9, cx: 0, cy: 0 }));
  svg.append(sv('path', { class: 'ptr', d: 'M0 -96 L-7 -114 L7 -114 Z' }));
  wrap.replaceChildren(svg);
  wrap.className = '';
}

function setRot(deg) { if (rot) rot.setAttribute('transform', `rotate(${deg.toFixed(3)})`); }

function frame() {
  raf = 0;
  const sp = w && w.spin;
  if (!sp || sp.id !== spinId) return;
  const p = Math.min(1, Math.max(0, (now() - sp.startedAt) / sp.durationMs));
  const e = 1 - Math.pow(1 - p, 4);
  setRot(finalAngle * e);
  if (p < 1) raf = requestAnimationFrame(frame);
}

function show(on) {
  stage.classList.toggle('show', on);
}

function showResult() {
  const r = w.result;
  const winner = w.winner && (!r || w.winner.ts >= r.ts) ? w.winner : null;
  if (!r && !winner) { res.className = 'card none'; return false; }
  const kick = r && r.kind === 'out' ? (winner ? 'Победитель' : 'Выбывает') : 'Победитель';
  const name = r && r.kind === 'out' && !winner ? r.name : winner ? winner.name : r.name;
  const sub = r && r.kind === 'out' ? (winner ? `последним выбыл: ${r.name}` : `осталось: ${w.left}`) : '';
  res.replaceChildren(CB.el('span', 'kick', kick), CB.el('div', 'nm grad', name), ...(sub ? [CB.el('div', 'sub', sub)] : []));
  res.className = 'card pop';
  // Подсветить выпавший сектор.
  if (r && rot) for (const n of rot.querySelectorAll('[data-id]')) n.classList.toggle('win-seg', n.dataset.id === r.id);
  return true;
}

function draw() {
  if (!cfg || !w) return;
  if (cfg.theme !== theme) { theme = cfg.theme; spinId = ''; }
  CB.theme(theme);
  clearTimeout(hideTimer);
  const sp = w.spin;
  if (sp) {
    if (sp.id !== spinId) {
      spinId = sp.id;
      shownSpin = sp;
      finalAngle = targetAngle(sp);
      build(sp);
    }
    res.className = 'card none';
    show(true);
    if (!raf) raf = requestAnimationFrame(frame);
    return;
  }
  // Прокрутка закончилась: колесо стоит на итоге (если мы видели эту прокрутку), под ним — результат.
  if (shownSpin) setRot(finalAngle);
  else wrap.className = 'none';
  const r = w.result;
  const ts = Math.max(r ? r.ts : 0, w.winner ? w.winner.ts : 0);
  const age = now() - ts;
  const hideMs = cfg.hideAfterSec * 1000;
  if (!showResult() || (hideMs > 0 && age > hideMs)) { show(false); return; }
  show(true);
  if (hideMs > 0) hideTimer = setTimeout(() => show(false), hideMs - age);
}

function take(d) {
  if (!d) return;
  w = d;
  offset = typeof d.now === 'number' ? d.now - Date.now() : 0;
}

CB.on('hello', (d) => { cfg = d.overlays.wheel; take(d.wheel); draw(); });
CB.on('config', (d) => { cfg = d.overlays.wheel; draw(); });
CB.on('wheel', (d) => { take(d.wheel); draw(); });
CB.connect();
