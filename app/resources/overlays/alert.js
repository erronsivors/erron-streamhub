'use strict';
// Оверлей алертов. Очередь живёт в Crossember: оверлей только показывает то, что пришло ('alert'),
// и прячет по команде ('alert-end'). Поэтому пауза, пропуск и «стоп всё» работают из приложения.
const stage = document.getElementById('stage');
const ICON = { donation: '₽', sub: '★', gift: '🎁', follow: '♥', raid: '↗', bits: '◆', reward: '✦' };
let shownId = null;
let audio = null;

function render(a) {
  const box = CB.el('div', 'alert card k-' + a.kind);
  box.append(CB.el('div', 'icon', ICON[a.kind] || '!'));
  const body = CB.el('div');
  const kicker = CB.el('div', 'kicker', a.kicker);
  if (a.test) kicker.append(CB.el('span', 'test', 'ТЕСТ'));
  const who = CB.el('div', 'who');
  for (const p of a.title || []) who.append(p.t === 'amount' ? CB.el('span', 'amt grad', p.v) : document.createTextNode(p.v));
  body.append(kicker, who);
  if (a.text) body.append(CB.el('div', 'text', a.text));
  box.append(body);
  return box;
}

function sound(a) {
  if (audio) { audio.pause(); audio = null; }
  if (!a.sound || !(a.volume > 0)) return;
  if (a.sound.builtin) return CBSound.play(a.sound.builtin, a.volume);
  // Свой файл: только с нашего сервера по строгому шаблону.
  if (typeof a.sound.url === 'string' && /^\/s\/[0-9a-f]{32}\.(mp3|wav|ogg)$/.test(a.sound.url)) {
    audio = new Audio(a.sound.url + '?k=' + encodeURIComponent(CB.key));
    audio.volume = Math.min(1, a.volume);
    audio.play().catch(() => {});
  }
}

function hide() {
  const box = stage.firstElementChild;
  shownId = null;
  if (!box) return;
  box.classList.remove('show');
  setTimeout(() => { if (box.parentNode && !box.classList.contains('show')) box.remove(); }, 600);
}

function show(a) {
  stage.replaceChildren();
  const box = render(a);
  stage.append(box);
  shownId = a.id;
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('show')));
  sound(a);
}

CB.on('hello', (d) => CB.theme(d.overlays.alert.theme));
CB.on('config', (d) => CB.theme(d.overlays.alert.theme));
CB.on('alert', (d) => { if (d.alert) show(d.alert); });
CB.on('alert-end', (d) => {
  if (d.id === shownId) {
    hide();
    if (audio) { audio.pause(); audio = null; }
  }
});
CB.connect();
