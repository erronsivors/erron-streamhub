'use strict';
// Оверлей алертов. Очередь живёт в Crossember: оверлей только показывает то, что пришло ('alert'),
// и прячет по команде ('alert-end'). Сам алерт — слои конструктора, их рисует общий движок alertkit.js.
const stage = document.getElementById('stage');
let shownId = null;
let handle = null;
let theme = 'general';
let hideTimer = null;

// Холст алерта 1920×1080; если источник в OBS другого размера — масштабируем целиком.
function fit() {
  const k = Math.min(window.innerWidth / AlertKit.W, window.innerHeight / AlertKit.H) || 1;
  stage.style.transform = 'scale(' + k + ')';
}
window.addEventListener('resize', fit);
fit();

const url = (src) => src + '?k=' + encodeURIComponent(CB.key);

function show(a) {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (handle) handle.stop();
  stage.classList.remove('gone');
  shownId = a.id;
  handle = AlertKit.mount(stage, a, { url, theme, playBuiltin: (id, v) => CBSound.play(id, v) });
}

function hide() {
  shownId = null;
  const h = handle;
  handle = null;
  if (!h) return;
  stage.classList.add('gone');
  hideTimer = setTimeout(() => { h.stop(); stage.classList.remove('gone'); hideTimer = null; }, 400);
}

const setTheme = (d) => { theme = d.overlays.alert.theme === 'campfire' ? 'campfire' : 'general'; CB.theme(theme); };
CB.on('hello', setTheme);
CB.on('config', setTheme);
CB.on('alert', (d) => { if (d.alert) show(d.alert); });
CB.on('alert-end', (d) => { if (d.id === shownId) hide(); });
CB.connect();
