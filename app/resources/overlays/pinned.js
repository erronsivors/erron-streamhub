'use strict';
// Закреплённое сообщение: стример кликает по сообщению в Crossember — оно появляется здесь.
const stage = document.getElementById('stage');

function apply(overlays) {
  CB.theme(overlays.pinned.theme);
  document.body.style.setProperty('--fs', overlays.pinned.fontSize + 'px');
}

function show(m) {
  const old = stage.firstElementChild;
  if (old) { old.classList.remove('show'); setTimeout(() => old.remove(), 350); }
  if (!m) return;
  const box = CB.el('div', 'pin card');
  box.append(CB.el('div', 'head', m.type === 'message' ? 'Сообщение зрителя' : 'Событие'));
  box.append(CB.line(m, { showBadges: true, showPlatform: true }));
  stage.append(box);
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('show')));
}

CB.on('hello', (d) => { apply(d.overlays); show(d.pinned); });
CB.on('config', (d) => apply(d.overlays));
CB.on('pinned', (d) => show(d.event));
CB.connect();
