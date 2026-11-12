'use strict';
// Голосование: вопрос, варианты с номерами и полосками, таймер, в конце — итог.
// Ники зрителей сюда не приходят — только варианты и число голосов.
// Долгое голосование видно не всё время: ядро присылает visible и showUntil (когда спрятать).
const stage = document.getElementById('stage');
let cfg = null;
let v = null;
let offset = 0;
let hideTimer = null;
const prev = new Map();

const mmss = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
};
const n = (x) => (Math.round((Number(x) || 0) * 10) / 10).toLocaleString('ru-RU');
const votesWord = (x) => {
  const k = Math.round(Number(x) || 0);
  if (k !== Number(x)) return 'голоса';
  const a = k % 10, b = k % 100;
  return a === 1 && b !== 11 ? 'голос' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'голоса' : 'голосов';
};
const now = () => Date.now() + offset;

function left(p) {
  if (p.timer.endsAt) return p.timer.endsAt - now();
  return p.timer.pausedLeft || 0;
}

function tickClock() {
  const c = document.getElementById('clock');
  const p = v && v.poll;
  if (c && p) {
    const t = p.timer;
    if (p.timeUp) { c.textContent = 'Время вышло'; c.className = 'clock'; }
    else if (!t.endsAt && !t.pausedLeft) c.textContent = '';
    else {
      const ms = left(p);
      c.textContent = mmss(ms);
      c.className = 'clock' + (t.endsAt && ms < 15000 ? ' low' : '') + (!t.endsAt ? ' paused' : '');
    }
  }
  const bar = document.getElementById('showbar');
  if (bar && v && v.showUntil && v.showFrom) {
    const k = Math.max(0, Math.min(1, (v.showUntil - now()) / Math.max(1, v.showUntil - v.showFrom)));
    bar.style.transform = `scaleX(${k})`;
  }
}

function hide() {
  if (stage.classList.contains('empty') || stage.classList.contains('hide')) return;
  stage.classList.add('hide');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { stage.className = 'card empty'; stage.replaceChildren(); prev.clear(); }, 500);
}

function draw() {
  if (!cfg || !v) return;
  CB.theme(cfg.theme);
  document.body.style.setProperty('--fs', cfg.fontSize + 'px');
  const p = v.poll;
  if (!p || !v.visible) { hide(); return; }
  clearTimeout(hideTimer);
  const wasHidden = stage.classList.contains('empty') || stage.classList.contains('hide');
  stage.className = 'card' + (wasHidden ? ' hide' : '');
  // Появление: кадр со скрытым видом, потом плавно к обычному (reflow вместо rAF — работает и в фоновой вкладке).
  if (wasHidden) { void stage.offsetWidth; stage.classList.remove('hide'); }

  const kicker = p.source === 'twitch' ? 'Голосование Twitch' : 'Голосование';

  // Итог: крупно, без списка.
  if (p.result) {
    const w = CB.el('div', 'win');
    w.append(CB.el('span', 'kick', p.result.tie ? 'Ничья' : 'Итог голосования'));
    if (p.title) w.append(CB.el('div', 'wq', p.title));
    w.append(CB.el('div', 'wn grad', p.result.name), CB.el('div', 'ws', `${n(p.result.votes)} ${votesWord(p.result.votes)}` + (p.total > 0 ? ` · ${n((p.result.votes / p.total) * 100)}%` : '')));
    stage.replaceChildren(w);
    if (v.showUntil) { const b = CB.el('div', 'showbar'); b.id = 'showbar'; stage.append(b); }
    tickClock();
    return;
  }

  const top = CB.el('div', 'top');
  top.append(CB.el('span', 'kick', kicker));
  top.append(CB.el('span', 'state', p.open ? (p.timer.endsAt || !p.timer.pausedLeft ? '' : 'пауза') : p.timeUp ? '' : 'приём голосов закрыт'));
  if (p.kind === 'quick') { const c = CB.el('span', 'clock'); c.id = 'clock'; top.append(c); }

  const nodes = [top];
  if (p.title) nodes.push(CB.el('div', 'q', p.title));

  const list = CB.el('div', 'opts');
  const opts = Array.isArray(p.options) ? p.options.slice(0, cfg.count) : [];
  const max = Math.max(1, ...opts.map((o) => o.votes));
  const total = p.total > 0 ? p.total : 1;
  const leadVotes = opts.length ? Math.max(...opts.map((o) => o.votes)) : 0;
  for (const o of opts) {
    const lead = leadVotes > 0 && o.votes === leadVotes;
    const row = CB.el('div', 'opt' + (lead ? ' lead' : ''));
    const line = CB.el('div', 'line');
    line.append(CB.el('span', 'num', o.num), CB.el('span', 'nm', o.name));
    const pct = Math.round((o.votes / total) * 1000) / 10;
    const val = CB.el('span', 'val' + (lead ? ' grad' : ''), cfg.show === 'pct' ? pct.toLocaleString('ru-RU') + '%' : n(o.votes));
    line.append(val);
    if (cfg.show === 'both') line.append(CB.el('span', 'pct', pct.toLocaleString('ru-RU') + '%'));
    const track = CB.el('div', 'track');
    const fill = CB.el('div', 'fill');
    const was = prev.has(o.id) ? prev.get(o.id) : 0;
    fill.style.width = (was / max) * 100 + '%';
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (o.votes / max) * 100 + '%'; }));
    track.append(fill);
    row.append(line, track);
    if (prev.has(o.id) && prev.get(o.id) !== o.votes) row.classList.add('bump');
    list.append(row);
  }
  prev.clear();
  for (const o of p.options || []) prev.set(o.id, o.votes);
  if (opts.length) nodes.push(list);

  const foot = CB.el('div', 'foot');
  if (p.total > 0) foot.append(CB.el('span', '', `Всего: ${n(p.total)} ${votesWord(p.total)}`));
  if (p.open && cfg.showHint) for (const h of p.hint || []) foot.append(CB.el('span', '', h));
  if (foot.childNodes.length) nodes.push(foot);
  if (v.showUntil) { const b = CB.el('div', 'showbar'); b.id = 'showbar'; nodes.push(b); }

  stage.replaceChildren(...nodes);
  tickClock();
}

function take(d) {
  if (!d) return;
  v = d;
  offset = typeof d.now === 'number' ? d.now - Date.now() : 0;
}

CB.on('hello', (d) => { cfg = d.overlays.vote; take(d.vote); draw(); });
CB.on('config', (d) => { cfg = d.overlays.vote; draw(); });
CB.on('vote', (d) => { take(d.vote); draw(); });
setInterval(tickClock, 250);
CB.connect();
