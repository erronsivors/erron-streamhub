'use strict';
// Последний донат (и по желанию последняя подписка).
const stage = document.getElementById('stage');
const CUR = { RUB: '₽', USD: '$', EUR: '€' };
let cfg = null;
let data = null;
let prevKey = '';

function item(label, e, withSum) {
  const row = CB.el('div', 'item card');
  row.append(CB.el('span', 'lbl', label));
  if (!e) { row.append(CB.el('span', 'nm', '—')); return row; }
  row.append(CB.el('span', 'nm', e.user));
  if (withSum && e.amount) row.append(CB.el('span', 'sum grad', e.amount.toLocaleString('ru-RU') + ' ' + (CUR[e.currency] || e.currency || '')));
  return row;
}

function draw() {
  if (!cfg) return;
  CB.theme(cfg.theme);
  document.body.style.setProperty('--fs', cfg.fontSize + 'px');
  const d = data || {};
  const key = (d.lastDonation && d.lastDonation.id) + '|' + (d.lastSub && d.lastSub.id);
  const rows = [item('Последний донат', d.lastDonation, true)];
  if (cfg.showSub) rows.push(item('Последняя подписка', d.lastSub, false));
  if (key !== prevKey && prevKey) rows.forEach((r) => r.classList.add('pop'));
  prevKey = key;
  stage.replaceChildren(...rows);
}

CB.on('hello', (d) => { cfg = d.overlays.last; data = d.stats; draw(); });
CB.on('config', (d) => { cfg = d.overlays.last; draw(); });
CB.on('stats', (d) => { data = d.stats; draw(); });
CB.connect();
