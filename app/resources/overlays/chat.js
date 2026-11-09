'use strict';
// Чат-оверлей. Режим по data-mode на <body>:
//   v — вертикальный (новые снизу), h — горизонтальный (новые слева), f — окно «чат поверх игры».
const list = document.getElementById('list');
const mode = document.body.dataset.mode;
const horizontal = mode === 'h';
let opts = null;

function apply(overlays) {
  opts = mode === 'h' ? overlays.chatH : mode === 'f' ? overlays.float : overlays.chat;
  CB.theme(opts.theme);
  document.body.style.setProperty('--fs', opts.fontSize + 'px');
  if (mode === 'f') document.body.style.setProperty('--bgp', opts.bgOpacity + '%');
  trim();
}

function trim() {
  while (list.children.length > opts.maxMessages) {
    if (horizontal) list.lastElementChild.remove();
    else list.firstElementChild.remove();
  }
}

function visible(m) {
  if (m.type === 'message') return true;
  return m.type === 'system' && opts.showStatus;
}

function add(m, animate) {
  let row;
  if (m.type === 'system') {
    row = CB.el('div', 'msg system', m.text);
    row.dataset.platform = m.platform;
  } else row = CB.line(m, opts);
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
  // Последние сообщения при перезапуске источника — только те, что ещё не должны были исчезнуть.
  const now = Date.now();
  const recent = d.chat
    .filter((m) => visible(m) && (opts.hideAfterSec === 0 || now - m.ts < opts.hideAfterSec * 1000))
    .slice(0, opts.maxMessages)
    .reverse();
  for (const m of recent) add(m, false);
});
CB.on('config', (d) => apply(d.overlays));
CB.on('event', (d) => { if (opts && d.event && visible(d.event)) add(d.event, true); });
CB.on('delete', (d) => {
  for (const row of [...list.children]) {
    const byId = d.id && row.dataset.id === d.id;
    const byUser = d.userId && row.dataset.user === d.platform + ':' + d.userId;
    const byPlatform = !d.id && !d.userId && d.platform && row.dataset.platform === d.platform && !row.classList.contains('system');
    if (byId || byUser || byPlatform) row.remove();
  }
});
CB.connect();
