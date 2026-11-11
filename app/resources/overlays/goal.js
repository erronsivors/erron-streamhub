'use strict';
// Сбор средств: цель, полоска с этапами, последний донат, топ сбора, срок; этап или цель достигнуты — праздник.
const stage = document.getElementById('stage');
let cfg = null;
let g = null;
let offset = 0; // разница часов ядра и страницы
let prevGot = null;
let partyTimer = null;

const money = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU') + ' ₽';
const now = () => Date.now() + offset;
const left = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (x) => String(x).padStart(2, '0');
  return d ? `${d} д ${h} ч` : h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
};

function tickClock() {
  const c = document.getElementById('clock');
  if (!c || !g) return;
  if (g.timeUp) { c.textContent = 'Сбор закрыт'; c.className = 'clock'; return; }
  if (!g.endsAt) { c.textContent = ''; return; }
  const ms = g.endsAt - now();
  c.textContent = left(ms);
  c.className = 'clock' + (ms < 5 * 60000 ? ' low' : '');
}

function partyNode() {
  const c = g.celebrate;
  if (!cfg.celebrate || !c) return null;
  const rest = 9000 - (now() - c.ts);
  if (rest <= 0) return null;
  const p = CB.el('div', 'party');
  p.append(CB.el('span', 'kick', c.kind === 'goal' ? 'Цель достигнута' : 'Этап достигнут'), CB.el('div', 'pn grad', c.name), CB.el('div', 'ps', money(c.rub)));
  clearTimeout(partyTimer);
  partyTimer = setTimeout(() => {
    p.classList.add('out');
    setTimeout(() => { p.remove(); stage.classList.remove('partying'); }, 500);
  }, Math.max(0, rest - 500));
  return p;
}

function draw() {
  if (!cfg) return;
  CB.theme(cfg.theme);
  document.body.style.setProperty('--fs', cfg.fontSize + 'px');
  if (!g) { stage.className = 'card empty'; stage.replaceChildren(); prevGot = null; return; }
  stage.className = 'card';

  const top = CB.el('div', 'top');
  top.append(CB.el('span', 'kick', 'Сбор средств'));
  if (!g.accepting && !g.timeUp) top.append(CB.el('span', 'state', 'пауза'));
  if (cfg.showTimer && (g.endsAt || g.timeUp)) { const c = CB.el('span', 'clock'); c.id = 'clock'; top.append(c); }

  const line = CB.el('div', 'line');
  const got = CB.el('span', 'got grad', money(g.collected));
  if (prevGot !== null && prevGot !== g.collected) got.classList.add('bump');
  const pct = Math.floor((g.collected / g.target) * 100);
  line.append(got, CB.el('span', 'of', '/ ' + money(g.target)), CB.el('span', 'pct', pct + '%'));

  const track = CB.el('div', 'track');
  const fill = CB.el('div', 'fill');
  const was = prevGot === null ? g.collected : prevGot;
  fill.style.width = Math.min(100, (was / g.target) * 100) + '%';
  requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = Math.min(100, (g.collected / g.target) * 100) + '%'; }));
  track.append(fill);
  if (cfg.showStages) {
    for (const s of g.stages) {
      const t = CB.el('i', 'tick' + (s.reached ? ' on' : ''));
      t.style.left = (s.rub / g.target) * 100 + '%';
      track.append(t);
    }
  }
  prevGot = g.collected;

  const parts = [top, CB.el('div', 'title', g.title), line, track];

  if (cfg.showStages) {
    const nx = g.stages.find((s) => !s.reached);
    const n = CB.el('div', 'next');
    if (nx) { n.append('Дальше: ', CB.el('b', '', nx.name), ' — ' + money(nx.rub)); parts.push(n); }
    else if (g.collected >= g.target) { n.append(CB.el('b', '', 'Цель достигнута!')); parts.push(n); }
  }

  const foot = CB.el('div', 'foot');
  if (cfg.showLast && g.last) {
    const d = CB.el('div');
    d.append(CB.el('span', 'lbl', 'Последний'), CB.el('b', '', g.last.user), ' — ' + money(g.last.rub));
    foot.append(d);
  }
  if (cfg.showTop && g.top.length) {
    const d = CB.el('div', 'tops');
    d.append(CB.el('span', 'lbl', 'Топ'));
    g.top.slice(0, cfg.topCount).forEach((x, i) => {
      const s = CB.el('span');
      s.append(i + 1 + '. ', CB.el('b', '', x.user), ' ' + money(x.rub));
      d.append(s);
    });
    foot.append(d);
  }
  if (foot.childNodes.length) parts.push(foot);

  const party = partyNode();
  if (party) parts.push(party);
  else clearTimeout(partyTimer);
  stage.classList.toggle('partying', !!party);
  stage.replaceChildren(...parts);
  tickClock();
}

function take(d) {
  g = d || null;
  if (g && typeof g.now === 'number') offset = g.now - Date.now();
}

CB.on('hello', (d) => { cfg = d.overlays.goal; take(d.goal); draw(); });
CB.on('config', (d) => { cfg = d.overlays.goal; draw(); });
CB.on('goal', (d) => { take(d.goal); draw(); });
setInterval(tickClock, 500);
CB.connect();
