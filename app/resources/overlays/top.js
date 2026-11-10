'use strict';
// Топ донатеров за период из настроек оверлея (эфир / сегодня / неделя / месяц / всё время).
const stage = document.getElementById('stage');
const PERIOD = { stream: 'за эфир', today: 'за сегодня', week: 'за неделю', month: 'за месяц', all: 'за всё время' };
let cfg = null;
let last = null;

function rub(n) { return Math.round(n).toLocaleString('ru-RU') + ' ₽'; }

function draw() {
  if (!cfg) return;
  CB.theme(cfg.theme);
  document.body.style.setProperty('--fs', cfg.fontSize + 'px');
  const box = CB.el('div', 'box card');
  box.append(CB.el('div', 'head', 'Топ донатеров ' + (PERIOD[cfg.period] || '')));
  const list = (last && Array.isArray(last.top)) ? last.top : [];
  if (!list.length) box.append(CB.el('div', 'empty', 'Пока нет донатов'));
  list.forEach((t, i) => {
    const row = CB.el('div', 'row');
    row.style.animationDelay = (i * 0.06) + 's';
    row.append(CB.el('span', 'pos', String(i + 1)), CB.el('span', 'nm', t.user), CB.el('span', 'sum grad', rub(t.rub)));
    box.append(row);
  });
  stage.replaceChildren(box);
}

CB.on('hello', (d) => { cfg = d.overlays.top; last = d.stats; draw(); });
CB.on('config', (d) => { cfg = d.overlays.top; draw(); });
CB.on('stats', (d) => { last = d.stats; draw(); });
CB.connect();
