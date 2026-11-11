'use strict';
// Розыгрыш: приглашение и число участников во время приёма; при выборе — прокрутка ников до победителя (он выбран в ядре заранее).
const stage = document.getElementById('stage');
let cfg = null;
let g = null;
let offset = 0;
let seq = null; // последовательность ников для текущей прокрутки
let seqId = '';
let hideTimer = null;

const now = () => Date.now() + offset;
const mmss = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
};
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
const ease = (t) => 1 - Math.pow(1 - t, 3);

function tickClock() {
  const c = document.getElementById('clock');
  if (!c || !g) return;
  if (!g.endsAt) { c.textContent = ''; return; }
  const ms = g.endsAt - now();
  c.textContent = mmss(ms);
  c.className = 'clock' + (ms < 30000 ? ' low' : '');
}

function tickRoll() {
  const el = document.getElementById('roll');
  const r = g && g.reveal;
  if (!el || !r || !seq) return;
  const t = Math.min(1, Math.max(0, (now() - r.startedAt) / r.durationMs));
  const i = Math.min(seq.length - 1, Math.floor((seq.length - 1) * ease(t)));
  if (el.textContent !== seq[i]) el.textContent = seq[i];
  el.classList.toggle('blur', t < 0.85);
}

function buildSeq(r) {
  if (seqId === r.id) return;
  seqId = r.id;
  const names = r.names.length ? r.names : r.winners;
  const out = [];
  while (out.length < 40) out.push(...names);
  seq = out.slice(0, 40);
  seq.push(r.winners[0] || '');
}

function draw() {
  if (!cfg) return;
  CB.theme(cfg.theme);
  document.body.style.setProperty('--fs', cfg.fontSize + 'px');
  clearTimeout(hideTimer);
  const hide = () => { stage.className = 'card empty'; stage.replaceChildren(); };
  if (!g) return hide();
  const parts = [];

  if (g.reveal) {
    buildSeq(g.reveal);
    parts.push(CB.el('div', 'kick', 'Выбираем победителя'));
    const roll = CB.el('div', 'roll');
    roll.id = 'roll';
    parts.push(roll);
    if (g.prize) parts.push(CB.el('div', 'for', g.prize));
  } else if (g.winners.length) {
    // Итог скрывается через N секунд после выбора (0 — не скрывать).
    if (cfg.hideAfterSec > 0 && g.drawnAt) {
      const rest = g.drawnAt + cfg.hideAfterSec * 1000 - now();
      if (rest <= 0 && !g.open) return hide();
      if (!g.open) hideTimer = setTimeout(draw, rest + 50);
    }
    parts.push(CB.el('div', 'kick', g.winners.length > 1 ? 'Победители розыгрыша' : 'Победитель розыгрыша'));
    const box = CB.el('div', 'wins' + (g.winners.length > 2 ? ' many' : ''));
    for (const w of g.winners) {
      const d = CB.el('div', 'wn');
      d.append(CB.el('span', 'grad', w.user));
      if (w.answered) d.append(CB.el('span', 'ok', '✓ на месте'));
      box.append(d);
    }
    parts.push(box);
    if (g.prize) parts.push(CB.el('div', 'for', g.prize));
  } else if (g.open || g.count > 0) {
    const top = CB.el('div', 'top');
    top.append(CB.el('span', 'kick', g.open ? 'Розыгрыш' : 'Приём участников закрыт'));
    if (g.open && g.endsAt) { const c = CB.el('span', 'clock'); c.id = 'clock'; top.append(c); }
    parts.push(top);
    if (g.prize) parts.push(CB.el('div', 'prize', g.prize));
    if (g.open) {
      const call = CB.el('div', 'call');
      call.append('Пиши ', CB.el('b', '', g.keyword), ' в чат');
      parts.push(call);
      if (g.rubPerTicket > 0) parts.push(CB.el('div', 'sub', `Каждые ${g.rubPerTicket.toLocaleString('ru-RU')} ₽ доната — ещё один билет`));
    }
    const c = CB.el('div', 'count');
    c.append(String(g.count), CB.el('span', '', ' ' + plural(g.count, 'участник', 'участника', 'участников')));
    parts.push(c);
  } else return hide();

  stage.className = 'card';
  stage.replaceChildren(...parts);
  tickClock();
  tickRoll();
}

function take(d) {
  g = d || null;
  if (g && typeof g.now === 'number') offset = g.now - Date.now();
}

CB.on('hello', (d) => { cfg = d.overlays.giveaway; take(d.giveaway); draw(); });
CB.on('config', (d) => { cfg = d.overlays.giveaway; draw(); });
CB.on('giveaway', (d) => { take(d.giveaway); draw(); });
setInterval(tickClock, 500);
setInterval(tickRoll, 50);
CB.connect();
