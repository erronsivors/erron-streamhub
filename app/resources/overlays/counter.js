'use strict';
// Счётчики: «Смерти 12», «Победы 3». Изменившееся число коротко «подпрыгивает».
const stage = document.getElementById('stage');
let cfg = null;
let list = [];
const prev = new Map();

function draw() {
  if (!cfg) return;
  CB.theme(cfg.theme);
  document.body.style.setProperty('--fs', cfg.fontSize + 'px');
  stage.className = cfg.layout === 'row' ? 'row' : '';
  const ids = Array.isArray(cfg.ids) ? cfg.ids : [];
  // Порядок — как выбран в настройках; пусто — все по порядку списка.
  const shown = ids.length ? ids.map((id) => list.find((c) => c.id === id)).filter(Boolean) : list;
  const rows = shown.map((c) => {
    const row = CB.el('div', 'item card');
    row.append(CB.el('span', 'lbl', c.name), CB.el('span', 'val grad', Number(c.value).toLocaleString('ru-RU')));
    if (prev.has(c.id) && prev.get(c.id) !== c.value) row.classList.add('bump');
    return row;
  });
  prev.clear();
  for (const c of list) prev.set(c.id, c.value);
  stage.replaceChildren(...rows);
}

CB.on('hello', (d) => { cfg = d.overlays.counter; list = Array.isArray(d.counters) ? d.counters : []; draw(); });
CB.on('config', (d) => { cfg = d.overlays.counter; draw(); });
CB.on('counters', (d) => { list = Array.isArray(d.counters) ? d.counters : []; draw(); });
CB.connect();
