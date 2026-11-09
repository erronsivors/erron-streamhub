'use strict';
// Чат-оверлей: вертикальный (новые снизу) или горизонтальный (новые слева) — по data-mode на <body>.
const list = document.getElementById('list');
const horizontal = document.body.dataset.mode === 'h';
let opts = null;

function apply(overlays) {
  opts = horizontal ? overlays.chatH : overlays.chat;
  CB.theme(opts.theme);
  document.body.style.setProperty('--fs', opts.fontSize + 'px');
  trim();
}

function trim() {
  while (list.children.length > opts.maxMessages) {
    if (horizontal) list.lastElementChild.remove();
    else list.firstElementChild.remove();
  }
}

function add(m, animate) {
  const row = CB.line(m, opts);
  row.classList.add('card');
  if (!animate) row.style.animation = 'none';
  if (horizontal) list.prepend(row);
  else list.append(row);
  trim();
  if (opts.hideAfterSec > 0) {
    setTimeout(() => { row.classList.add('gone'); setTimeout(() => row.remove(), 700); }, opts.hideAfterSec * 1000);
  }
}

CB.on('hello', (d) => {
  apply(d.overlays);
  list.replaceChildren();
  // Последние сообщения при перезапуске источника — но только если они не должны были уже исчезнуть.
  const now = Date.now();
  const recent = d.chat.filter((m) => opts.hideAfterSec === 0 || now - m.ts < opts.hideAfterSec * 1000).slice(0, opts.maxMessages).reverse();
  for (const m of recent) add(m, false);
});
CB.on('config', (d) => apply(d.overlays));
CB.on('event', (d) => { if (opts && d.event && d.event.type === 'message') add(d.event, true); });
CB.on('delete', (d) => {
  for (const row of [...list.children]) {
    const byId = d.id && row.dataset.id === d.id;
    const byUser = d.userId && row.dataset.user === d.platform + ':' + d.userId;
    const byPlatform = !d.id && !d.userId && d.platform && row.dataset.platform === d.platform;
    if (byId || byUser || byPlatform) row.remove();
  }
});
CB.connect();
