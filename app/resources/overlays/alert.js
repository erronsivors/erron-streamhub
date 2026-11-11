'use strict';
// Оверлей алертов. Очередь живёт в Crossember: оверлей только показывает то, что пришло ('alert'),
// и прячет по команде ('alert-end'). Сам алерт — слои конструктора, их рисует общий движок alertkit.js.
// Если копий оверлея несколько (OBS и браузер), звук играет только «главная» — её выбирает ядро ('role').
const stage = document.getElementById('stage');
let shownId = null;
let shownAt = 0;
let handle = null;
let theme = 'general';
let hideTimer = null;
let main = false;
let late = false;
/** Уже показанные алерты: повтор того же id (например, после переподключения) не показывается заново. */
const seen = [];
/** Звук, пришедший позже этого, не играется (связь подвисла, алерт уже идёт в эфире). */
const LATE_MS = 1500;

// Холст алерта 1920×1080; если источник в OBS другого размера — масштабируем целиком.
function fit() {
  const k = Math.min(window.innerWidth / AlertKit.W, window.innerHeight / AlertKit.H) || 1;
  stage.style.transform = 'scale(' + k + ')';
}
window.addEventListener('resize', fit);
fit();

const url = (src) => src + '?k=' + encodeURIComponent(CB.key);
const canSound = () => main && CB.visible && !late;

/** Показать алерт. at — когда ядро его запустило (часы того же ПК); silent — без звука (снимок после переподключения). */
function show(a, at, silent) {
  if (!a || a.id === shownId) return;
  if (seen.includes(a.id)) return;
  seen.push(a.id);
  if (seen.length > 50) seen.shift();
  const elapsed = Math.max(0, Date.now() - (at || Date.now()));
  // Алерт почти закончился — не показывать обрывок.
  if (elapsed > a.durationMs - 800) return;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (handle) handle.stop();
  stage.classList.remove('gone');
  shownId = a.id;
  late = silent || elapsed > LATE_MS;
  // Небольшая задержка доставки — показываем с начала; опоздали — с нужного места и без звука.
  const offset = late ? elapsed : 0;
  shownAt = Date.now() - offset;
  handle = AlertKit.mount(stage, a, { url, theme, canSound, offset, playBuiltin: (id, v) => CBSound.play(id, v) });
  if (!CB.visible) handle.pause();
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
CB.on('hello', (d) => {
  setTheme(d);
  // Снимок после (пере)подключения: алерт, который сейчас идёт, — с нужного места и без звука.
  // Звук этого алерта уже прозвучал (или прозвучит) в главной копии — здесь без звука.
  if (d.alert) show(d.alert.item, d.alert.at, true);
  else if (shownId) hide();
});
CB.on('config', setTheme);
CB.on('role', (d) => { main = !!d.main; });
// Связь оборвалась — главной копией может стать другая; роль придёт заново после переподключения.
CB.on('closed', () => { main = false; });
CB.on('alert', (d) => { if (d.alert) show(d.alert, d.at); });
CB.on('alert-end', (d) => { if (d.id === shownId) hide(); });
// Источник скрыт — пауза; снова виден — продолжить с того места, где алерт сейчас по часам ядра.
CB.on('visibility', (v) => {
  if (!handle) return;
  if (!v) handle.pause();
  else handle.resume(Date.now() - shownAt); // звуки, чьё время прошло, пока источник был скрыт, уже пропущены
});
CB.connect();
