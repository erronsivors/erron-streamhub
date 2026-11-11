'use strict';
// Аукцион: таймер и топ лотов с полосками доли. Ставки и ники зрителей сюда не приходят — только лоты и суммы.
const stage = document.getElementById('stage');
let cfg = null;
let a = null;
let offset = 0; // разница часов ядра и страницы (на одном ПК — почти ноль)
const prevSum = new Map();

const money = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU') + ' ₽';
const mmss = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
};

function left() {
  if (!a) return 0;
  if (a.timer.endsAt) return a.timer.endsAt - (Date.now() + offset);
  return a.timer.pausedLeft || 0;
}

function clockNode() {
  const c = CB.el('span', 'clock');
  c.id = 'clock';
  return c;
}

function tickClock() {
  const c = document.getElementById('clock');
  if (!c || !a) return;
  const t = a.timer;
  if (a.timeUp) { c.textContent = 'Время вышло'; c.className = 'clock'; return; }
  if (!t.endsAt && !t.pausedLeft) { c.textContent = ''; return; }
  const ms = left();
  c.textContent = mmss(ms);
  c.className = 'clock' + (t.endsAt && ms < 60000 ? ' low' : '') + (!t.endsAt ? ' paused' : '');
}

function draw() {
  if (!cfg || !a) return;
  CB.theme(cfg.theme);
  document.body.style.setProperty('--fs', cfg.fontSize + 'px');
  const lots = (Array.isArray(a.lots) ? a.lots : []).slice(0, cfg.count);
  const hasTimer = !!(a.timer.endsAt || a.timer.pausedLeft || a.timeUp);
  if (!lots.length && !a.winner && !a.accepting && !hasTimer) { stage.className = 'card empty'; stage.replaceChildren(); return; }
  stage.className = 'card';

  // Победитель объявлен — крупно, без списка.
  if (a.winner) {
    const w = CB.el('div', 'win');
    w.append(CB.el('span', 'kick', 'Победитель аукциона'), CB.el('div', 'wn grad', a.winner.name), CB.el('div', 'ws', money(a.winner.rub)));
    stage.replaceChildren(w);
    return;
  }

  const top = CB.el('div', 'top');
  top.append(CB.el('span', 'kick', 'Аукцион'));
  top.append(CB.el('span', 'state', a.accepting ? (a.timer.endsAt || !a.timer.pausedLeft ? '' : 'пауза') : a.timeUp ? '' : 'приём ставок закрыт'));
  if (cfg.showTimer) top.append(clockNode());

  const list = CB.el('div', 'lots');
  const max = lots.length ? Math.max(...lots.map((l) => l.rub), 1) : 1;
  const total = a.total > 0 ? a.total : 1;
  lots.forEach((l, i) => {
    const row = CB.el('div', 'lot' + (i === 0 && l.rub > 0 ? ' lead' : ''));
    const line = CB.el('div', 'line');
    line.append(CB.el('span', 'num', '#' + l.num), CB.el('span', 'nm', l.name));
    const val = CB.el('span', 'val' + (i === 0 && l.rub > 0 ? ' grad' : ''));
    const pct = Math.round((l.rub / total) * 1000) / 10;
    if (cfg.show === 'pct') val.textContent = pct.toLocaleString('ru-RU') + '%';
    else val.textContent = money(l.rub);
    line.append(val);
    if (cfg.show === 'both') line.append(CB.el('span', 'pct', pct.toLocaleString('ru-RU') + '%'));
    const track = CB.el('div', 'track');
    const fill = CB.el('div', 'fill');
    // Полоска растёт с прошлой ширины до новой.
    const was = prevSum.has(l.id) ? prevSum.get(l.id) : 0;
    fill.style.width = (was / max) * 100 + '%';
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (l.rub / max) * 100 + '%'; }));
    track.append(fill);
    row.append(line, track);
    if (prevSum.has(l.id) && prevSum.get(l.id) !== l.rub) row.classList.add('bump');
    list.append(row);
  });
  prevSum.clear();
  for (const l of a.lots || []) prevSum.set(l.id, l.rub);

  const foot = CB.el('div', 'foot');
  if (a.total > 0) foot.append(CB.el('span', '', 'Всего: ' + money(a.total)));
  if (a.accepting) foot.append(CB.el('span', '', 'Ставка — донат с названием или #номером лота'));

  stage.replaceChildren(top, ...(lots.length ? [list] : []), foot);
  tickClock();
}

function take(d) {
  if (!d) return;
  a = d;
  offset = typeof d.now === 'number' ? d.now - Date.now() : 0;
}

CB.on('hello', (d) => { cfg = d.overlays.auction; take(d.auction); draw(); });
CB.on('config', (d) => { cfg = d.overlays.auction; draw(); });
CB.on('auction', (d) => { take(d.auction); draw(); });
setInterval(tickClock, 250);
CB.connect();
