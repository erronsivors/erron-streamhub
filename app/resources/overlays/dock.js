'use strict';
// Док Crossember: для OBS (Docks → Custom Browser Docks) и для второго устройства.
// Блоки выбираются в Crossember (или параметром ссылки b=chat,alerts,…). Весь текст — только через textContent.
const $ = (id) => document.getElementById(id);
const el = CB.el;
const LABEL = { donation: 'донат', follow: 'фоллоу', sub: 'подписка', gift: 'подарочные подписки', raid: 'рейд', bits: 'биты', reward: 'награда' };
const ALL = ['chat', 'events', 'alerts', 'auction', 'vote', 'goal', 'giveaway', 'wheel', 'counters'];
const GROUPS = [
  { id: 'chat', name: 'Чат', blocks: ['chat'] },
  { id: 'alerts', name: 'Алерты', blocks: ['alerts', 'events'] },
  { id: 'live', name: 'Эфир', blocks: ['auction', 'vote', 'goal', 'giveaway', 'wheel', 'counters'] }
];
const fixed = new URLSearchParams(location.search).get('b');

let role = 'dock';
let blocks = [];
let control = false;
let dock = null;
let skew = 0;
let pinnedId = null;
let chatLog = [];
let events = [];
let tab = null;
try { tab = localStorage.getItem('cb-dock-tab'); } catch { /* без памяти вкладки */ }
const asks = new Map();
let toastTimer = null;

// ---------- помощники ----------
const now = () => Date.now() - skew;
const rub = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const clock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};
const act = (a, ...args) => CB.send({ kind: 'act', a, args });
function btn(text, onClick, cls) {
  const b = el('button', 'b' + (cls ? ' ' + cls : ''), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
/** Кнопка с подтверждением: первый клик — «Точно?», второй (в течение 3 с) — действие. */
function askBtn(id, text, onYes, cls) {
  const asking = (asks.get(id) || 0) > Date.now();
  return btn(asking ? 'Точно?' : text, () => {
    if ((asks.get(id) || 0) > Date.now()) { asks.delete(id); onYes(); } else { asks.set(id, Date.now() + 3000); setTimeout(renderAll, 3050); }
    renderAll();
  }, asking ? 'ask' + (cls ? ' ' + cls : '') : cls);
}
function sec(title, right) {
  const s = el('section', 'sec');
  const h = el('h3', null, title);
  if (right) { const r = typeof right === 'string' ? el('span', 'r muted', right) : right; r.classList.add('r'); h.append(r); }
  s.append(h);
  return s;
}
function row(...kids) { const r = el('div', 'row'); r.append(...kids.filter(Boolean)); return r; }
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}

function renderAll() { renderAlerts(); renderLive(); }

// ---------- раскладка ----------
const has = (b) => blocks.includes(b);
const groupsOn = () => GROUPS.filter((g) => g.blocks.some(has));
const groupEls = {};

function applyBlocks(list, ctl) {
  const want = fixed ? fixed.split(',') : Array.isArray(list) ? list : ALL;
  control = !!ctl;
  let next = ALL.filter((b) => want.includes(b));
  // На втором устройстве без разрешения — только чат и события.
  if (role === 'remote' && !control) next = next.filter((b) => b === 'chat' || b === 'events');
  if (role === 'remote' && !next.length) next = ['chat', 'events'];
  if (next.join() === blocks.join()) return;
  blocks = next;
  layout();
}

function layout() {
  const main = $('main');
  const nav = $('tabs');
  main.replaceChildren();
  nav.replaceChildren();
  const gs = groupsOn();
  if (!gs.length) {
    main.append(el('div', 'empty', 'В этом доке не выбрано ни одного блока. Отметьте нужные в Crossember → Оверлеи → Док для OBS.'));
    nav.hidden = true;
    return;
  }
  if (!gs.some((g) => g.id === tab)) tab = gs[0].id;
  nav.hidden = gs.length < 2;
  for (const g of gs) {
    const box = el('div', 'group' + (g.id === 'chat' ? ' chatg' : ''));
    box.dataset.g = g.id;
    groupEls[g.id] = box;
    main.append(box);
    const t = btn(g.name, () => { tab = g.id; try { localStorage.setItem('cb-dock-tab', tab); } catch { /* ок */ } markTab(); });
    t.className = '';
    t.dataset.g = g.id;
    nav.append(t);
  }
  buildChat();
  renderAlerts();
  renderLive();
  markTab();
  fit();
}

function markTab() {
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.g === tab);
  for (const g of $('main').children) g.classList.toggle('on', g.dataset.g === tab);
}

function badge(gid, n) {
  const b = [...$('tabs').children].find((x) => x.dataset.g === gid);
  if (!b) return;
  b.querySelector('.n')?.remove();
  if (n > 0) b.append(el('span', 'n', n > 99 ? '99+' : n));
}

/** Широкое окно (второй ПК, большой док) — группы колонками, без вкладок. */
function fit() { document.body.classList.toggle('wide', window.innerWidth >= 900 && groupsOn().length > 1); }
window.addEventListener('resize', fit);

// ---------- чат ----------
let chatBox = null;
const lineOpts = { showBadges: true, showPlatform: true };
function atBottom() { return !chatBox || chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 40; }

function buildChat() {
  chatBox = null;
  const g = groupEls.chat;
  if (!g || !has('chat')) return;
  chatBox = el('div');
  chatBox.id = 'chat';
  const hint = el('div', 'chint', 'Клик по сообщению — в оверлей «Закреп», ещё клик — снять');
  const f = el('form');
  const t = el('input');
  t.id = 't';
  t.maxLength = 500;
  t.placeholder = 'Написать во все чаты…';
  t.autocomplete = 'off';
  const send = el('button', 'b pri', 'Отправить');
  f.append(t, send);
  f.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = t.value.trim();
    if (!text) return;
    CB.send({ kind: 'send', text });
    t.value = '';
  });
  g.replaceChildren(chatBox, hint, f);
  for (const m of chatLog) addMsg(m, false);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function addMsg(m, keep = true) {
  if (keep) { chatLog.push(m); if (chatLog.length > 200) chatLog.shift(); }
  if (!chatBox) return;
  const stick = atBottom();
  const r = CB.line(m, lineOpts);
  if (m.id === pinnedId) r.classList.add('pinned');
  r.addEventListener('click', () => CB.send({ kind: 'pin', id: m.id }));
  chatBox.append(r);
  while (chatBox.children.length > 200) chatBox.firstElementChild.remove();
  if (stick) chatBox.scrollTop = chatBox.scrollHeight;
}

function markPinned() {
  if (chatBox) for (const r of chatBox.children) r.classList.toggle('pinned', r.dataset.id === pinnedId);
}

// ---------- алерты и события ----------
function renderAlerts() {
  const g = groupEls.alerts;
  const a = dock && dock.alerts;
  if (a) {
    const cur = a.current;
    const nowEl = $('now');
    nowEl.replaceChildren();
    if (cur) nowEl.append('· сейчас: ', el('b', null, cur.summary));
    else if (a.paused) nowEl.append('· алерты на паузе');
  }
  badge('alerts', a ? a.queued : 0);
  if (!g) return;
  g.replaceChildren();
  if (has('alerts')) {
    const s = sec('Алерты', a ? (a.paused ? 'пауза' : a.enabled ? 'идут' : 'выключены') : '');
    if (!a) s.append(el('div', 'muted small', 'Нет данных'));
    else {
      const cur = el('div', 'li');
      cur.append(el('span', 'grow ell', a.current ? a.current.summary : 'Сейчас ничего не показывается'));
      if (a.current) cur.append(btn('Пропустить', () => act('alerts.skip'), 'sm'));
      s.append(cur);
      s.append(row(
        btn(a.paused ? 'Продолжить' : 'Пауза', () => act('alerts.pause', !a.paused), a.paused ? 'on' : ''),
        askBtn('stopAll', 'Очистить очередь', () => act('alerts.stopAll')),
        el('span', 'grow'),
        el('span', 'muted small', a.queued ? 'в очереди: ' + a.queued : 'очередь пуста')
      ));
      if (a.queue.length) {
        const l = el('div', 'list');
        for (const q of a.queue) {
          const it = el('div', 'li');
          it.append(el('span', 'plat p-' + q.platform), el('span', 'grow ell', q.summary));
          if (q.test) it.append(el('span', 'tag', 'тест'));
          it.append(btn('×', () => act('alerts.remove', q.id), 'sm ic'));
          l.append(it);
        }
        s.append(l);
      }
      s.append(row(el('span', 'muted small', 'Проверка:'),
        btn('Донат', () => act('test', 'donation'), 'sm'), btn('Подписка', () => act('test', 'sub'), 'sm'), btn('Фоллоу', () => act('test', 'follow'), 'sm')));
      s.lastChild.style.marginTop = '10px';
    }
    g.append(s);
  }
  if (has('events')) {
    const s = sec('Последние события');
    if (!events.length) s.append(el('div', 'muted small', 'Пока ничего'));
    for (const e of events.slice(0, 30)) {
      const box = el('div', 'ev');
      let title = e.user + ' · ' + (LABEL[e.type] || e.type);
      if (e.type === 'donation' && e.amount) title += ' · ' + e.amount + ' ' + (e.currency || '');
      box.append(el('b', null, title));
      if (e.text) box.append(el('small', null, e.text));
      s.append(box);
    }
    g.append(s);
  }
}

function addEvent(e) {
  events.unshift(e);
  if (events.length > 50) events.pop();
  if (has('events')) renderAlerts();
}

// ---------- эфир: аукцион, сбор, розыгрыш, колесо, счётчики ----------
function renderLive() {
  const g = groupEls.live;
  if (!g) return;
  const top = g.scrollTop;
  const focused = document.activeElement && document.activeElement.id === 'goalAdd' ? document.activeElement.value : null;
  g.replaceChildren();
  if (!dock) { g.append(el('div', 'empty', 'Загрузка…')); return; }
  if (has('auction')) g.append(auctionSec(dock.auction));
  if (has('vote') && dock.vote) g.append(voteSec(dock.vote));
  if (has('goal')) g.append(goalSec(dock.goal));
  if (has('giveaway')) g.append(giveawaySec(dock.giveaway));
  if (has('wheel')) g.append(wheelSec(dock.wheel));
  if (has('counters')) g.append(countersSec(dock.counters));
  g.scrollTop = top;
  if (focused !== null) { const i = $('goalAdd'); if (i) { i.value = focused; i.focus(); } }
}

function auctionLeft(a) {
  if (a.timer.endsAt) return a.timer.endsAt - now();
  return a.timer.pausedLeft;
}

function auctionSec(a) {
  const left = auctionLeft(a);
  const state = a.winner ? el('span', 'tag ok', 'итог') : a.timeUp ? el('span', 'tag warn', 'время вышло') : a.timer.endsAt ? el('span', 'tag ok', 'идёт') : a.accepting ? el('span', 'tag', 'приём открыт') : el('span', 'tag', 'приём закрыт');
  const s = sec('Аукцион', state);
  const t = el('span', 'big', left != null ? clock(left) : '—:—');
  t.dataset.timer = 'auction';
  s.append(row(t, el('span', 'grow'), el('span', 'muted small', rub(a.total) + ' · лотов: ' + a.lotCount)));
  s.append(row(
    a.timer.endsAt ? btn('Пауза', () => act('auction.timer', 'pause')) : btn('Старт', () => act('auction.timer', 'start'), 'pri'),
    btn('−1 мин', () => act('auction.timer', 'sub', 60), 'sm'),
    btn('+1 мин', () => act('auction.timer', 'add', 60), 'sm'),
    btn(a.accepting ? 'Закрыть приём' : 'Открыть приём', () => act('auction.accepting', !a.accepting), 'sm'),
    askBtn('aucFinish', 'Итог', () => act('auction.finish'), 'sm')
  ));
  if (a.pending) s.append(row(el('span', 'tag warn', 'Требует решения: ' + a.pending), el('span', 'muted small', 'разберите в Crossember')));
  if (a.winner) s.append(row(el('span', 'muted small', 'Победитель:'), el('b', 'ell', a.winner.name), el('span', 'muted small', rub(a.winner.rub))));
  if (a.lots.length) {
    const l = el('div', 'list');
    for (const lot of a.lots) {
      const it = el('div', 'li');
      it.append(el('span', 'muted small', '#' + lot.num), el('span', 'grow ell', lot.name), el('span', 'v', rub(lot.rub)));
      l.append(it);
    }
    s.append(l);
  }
  return s;
}

function goalSec(gl) {
  if (!gl) {
    const s = sec('Сбор средств');
    s.append(el('div', 'muted small', 'Сбор не запущен — начните его в Crossember → Сбор средств'));
    return s;
  }
  const left = gl.endsAt && !gl.timeUp ? gl.endsAt - now() : null;
  const state = gl.timeUp ? el('span', 'tag warn', 'срок вышел') : !gl.accepting ? el('span', 'tag', 'пауза') : left != null ? el('span', 'tag ok', 'осталось ' + clock(left)) : el('span', 'tag ok', 'идёт');
  if (left != null && !gl.timeUp && gl.accepting) state.dataset.timer = 'goal';
  const s = sec('Сбор средств', state);
  s.append(row(el('b', 'grow ell', gl.title)));
  const bar = el('div', 'bar');
  const fill = el('i');
  fill.style.width = Math.min(100, gl.target ? (gl.collected / gl.target) * 100 : 0).toFixed(1) + '%';
  bar.append(fill);
  s.append(bar);
  s.append(row(el('span', 'small', rub(gl.collected) + ' из ' + rub(gl.target)), el('span', 'grow'),
    el('span', 'muted small', gl.last ? 'последний: ' + gl.last.user + ', ' + rub(gl.last.rub) : '')));
  const inp = el('input', 'num');
  inp.id = 'goalAdd';
  inp.type = 'number';
  inp.min = '1';
  inp.placeholder = '₽';
  const add = () => {
    const v = Number(inp.value);
    if (!(v > 0)) { inp.focus(); return; }
    act('goal.add', v);
    inp.value = '';
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  const r = row(
    btn(gl.accepting && !gl.timeUp ? 'Пауза' : 'Продолжить', () => act('goal.accepting', !(gl.accepting && !gl.timeUp)), 'sm'),
    btn('+15 мин', () => act('goal.extend', 15), 'sm'),
    btn('+1 ч', () => act('goal.extend', 60), 'sm'),
    el('span', 'grow'), inp, btn('Добавить', add, 'sm')
  );
  r.style.marginTop = '8px';
  s.append(r);
  return s;
}

function giveawaySec(gw) {
  const left = gw.open && gw.endsAt ? gw.endsAt - now() : null;
  const state = gw.revealing ? el('span', 'tag ok', 'выбираем…') : gw.open ? el('span', 'tag ok', left != null ? 'приём · ' + clock(left) : 'приём идёт') : gw.winners.length ? el('span', 'tag', 'итог') : el('span', 'tag', 'не идёт');
  if (left != null) state.dataset.timer = 'giveaway';
  const s = sec('Розыгрыш', state);
  s.append(row(el('b', 'grow ell', gw.prize || 'Приз не указан'), el('span', 'muted small', 'участников: ' + gw.count + (gw.tickets !== gw.count ? ' · билетов: ' + gw.tickets : ''))));
  if (gw.open) s.append(row(el('span', 'muted small', 'Слово для участия:'), el('b', null, gw.keyword)));
  const r = gw.open
    ? row(btn('+1 мин', () => act('giveaway.extend', 1), 'sm'), btn('Закрыть приём', () => act('giveaway.close'), 'sm'), btn('Выбрать победителя', () => act('giveaway.draw'), 'pri'))
    : row(btn('Начать приём', () => act('giveaway.start'), gw.winners.length ? 'sm' : 'pri'), gw.count ? btn('Выбрать победителя', () => act('giveaway.draw'), gw.winners.length ? 'sm' : '') : null);
  if (gw.revealing) for (const b of r.querySelectorAll('button')) b.disabled = true;
  r.style.marginTop = '8px';
  s.append(r);
  if (gw.winners.length) {
    const l = el('div', 'list');
    for (const w of gw.winners) {
      const it = el('div', 'li');
      const wait = w.deadline - now();
      const st = w.answered ? el('span', 'tag ok', 'на месте') : wait > 0 ? el('span', 'tag warn', 'ждём ' + clock(wait)) : el('span', 'tag bad', 'молчит');
      if (!w.answered && wait > 0) st.dataset.timer = 'w:' + w.key;
      it.append(el('b', 'grow ell', w.user), st);
      if (!w.answered) it.append(askBtn('rr:' + w.key, 'Перевыбрать', () => act('giveaway.reroll', w.key), 'sm'));
      l.append(it);
    }
    s.append(l);
  }
  return s;
}

function votePoll(p, kind, showUntil) {
  const it = el('div', 'li');
  it.style.flexWrap = 'wrap';
  const name = (kind === 'quick' ? 'Быстрое' : 'Долгое') + (p.source === 'twitch' ? ' · Twitch' : '');
  const left = kind === 'quick' && p.open && p.endsAt ? p.endsAt - now() : null;
  const st = p.result ? el('span', 'tag ok', 'итог') : p.timeUp ? el('span', 'tag warn', 'время вышло') : p.open ? el('span', 'tag ok', left != null ? clock(left) : 'идёт') : el('span', 'tag', 'приём закрыт');
  if (left != null) st.dataset.timer = 'vote';
  it.append(el('b', 'grow ell', name + (p.title ? ': ' + p.title : '')), st);
  const line = el('div', 'muted small ell');
  line.style.flexBasis = '100%';
  line.textContent = p.result ? 'Победил: ' + p.result : p.top.length ? p.top.map((o) => o.num + ') ' + o.name + ' — ' + o.votes).join(' · ') : 'Голосов пока нет';
  it.append(line);
  const r = el('div', 'row');
  r.style.flexBasis = '100%';
  if (kind === 'quick' && p.open && p.source === 'own') r.append(btn('+30 с', () => act('vote.timer', 'add', 30), 'sm'));
  if (kind === 'long') r.append(btn(showUntil && showUntil > now() ? 'Спрятать' : 'Показать', () => act('vote.show'), 'sm'));
  if (p.open) r.append(btn('Завершить', () => act('vote.finish', kind), 'pri'));
  else r.append(askBtn('vc:' + kind, 'Убрать', () => act('vote.close', kind), 'sm'));
  if (p.pending) r.append(el('span', 'muted small', 'предложений: ' + p.pending));
  it.append(r);
  return it;
}

function voteSec(v) {
  const s = sec('Голосование');
  if (!v.quick && !v.long) { s.append(el('div', 'muted small', 'Голосований нет — запустите в Crossember → Интерактив → Голосование')); return s; }
  const l = el('div', 'list');
  if (v.quick) l.append(votePoll(v.quick, 'quick', null));
  if (v.long) l.append(votePoll(v.long, 'long', v.showUntil));
  s.append(l);
  return s;
}

function wheelSec(w) {
  const s = sec('Колесо', w.spinning ? el('span', 'tag ok', 'крутится') : w.items ? 'вариантов: ' + (w.left || w.items) : '');
  const res = w.winner ? 'Победитель: ' + w.winner : w.result ? (w.result.kind === 'out' ? 'Выбыл: ' : 'Выпало: ') + w.result.name : w.items < 2 ? 'Добавьте варианты в Crossember → Колесо' : 'Готово к прокрутке';
  const b = btn('Крутить', () => act('wheel.spin'), 'pri');
  b.disabled = w.spinning || w.items < 2;
  s.append(row(el('span', 'grow ell small' + (w.winner || w.result ? '' : ' muted'), res), b));
  return s;
}

function countersSec(list) {
  const s = sec('Счётчики');
  if (!list.length) { s.append(el('div', 'muted small', 'Счётчиков нет — добавьте в Crossember → Правила')); return s; }
  const l = el('div', 'list');
  for (const c of list) {
    const it = el('div', 'li');
    it.append(el('span', 'grow ell', c.name), btn('−', () => act('counter', c.id, 'sub'), 'sm ic'), el('span', 'cnt', c.value), btn('+', () => act('counter', c.id, 'add'), 'sm ic'));
    l.append(it);
  }
  s.append(l);
  return s;
}

// Таймеры тикают раз в секунду без перерисовки всего дока.
setInterval(() => {
  if (!dock) return;
  for (const n of document.querySelectorAll('[data-timer]')) {
    const id = n.dataset.timer;
    let ms = null;
    if (id === 'auction') { ms = auctionLeft(dock.auction); if (ms != null) n.textContent = clock(ms); continue; }
    if (id === 'goal' && dock.goal && dock.goal.endsAt) n.textContent = 'осталось ' + clock(dock.goal.endsAt - now());
    if (id === 'vote' && dock.vote && dock.vote.quick && dock.vote.quick.endsAt) { n.textContent = clock(dock.vote.quick.endsAt - now()); continue; }
    if (id === 'giveaway' && dock.giveaway.endsAt) n.textContent = 'приём · ' + clock(dock.giveaway.endsAt - now());
    if (id.startsWith('w:')) {
      const w = dock.giveaway.winners.find((x) => 'w:' + x.key === id);
      if (w) { ms = w.deadline - now(); n.textContent = ms > 0 ? 'ждём ' + clock(ms) : 'молчит'; if (ms <= 0) { n.className = 'tag bad'; delete n.dataset.timer; } }
    }
  }
}, 1000);

// ---------- связь ----------
CB.on('open', () => { $('dot').className = 'dot on'; $('st').textContent = 'на связи'; });
CB.on('closed', (c) => { $('dot').className = 'dot off'; $('st').textContent = c.code === 4003 ? 'ссылка устарела' : 'нет связи…'; });
CB.on('hello', (d) => {
  role = d.role === 'remote' ? 'remote' : 'dock';
  pinnedId = d.pinned ? d.pinned.id : null;
  chatLog = d.chat.slice().reverse();
  events = d.events.slice();
  if (d.dock) { dock = d.dock; skew = Date.now() - d.dock.now; }
  blocks = [];
  applyBlocks(d.dockBlocks, d.lanControl);
  if (role === 'remote' && !control) $('now').textContent = '· чат для второго устройства';
});
CB.on('config', (d) => { if (d.dockBlocks) applyBlocks(d.dockBlocks, d.lanControl); });
CB.on('dock', (d) => {
  dock = d.dock;
  skew = Date.now() - d.dock.now;
  renderAlerts();
  renderLive();
});
CB.on('event', (d) => {
  const e = d.event;
  if (!e) return;
  if (e.type === 'message') addMsg(e); else if (e.type !== 'system') addEvent(e);
});
CB.on('delete', (d) => {
  chatLog = chatLog.filter((m) => !((d.id && m.id === d.id) || (d.userId && m.platform === d.platform && m.userId === d.userId) || (!d.id && !d.userId && m.platform === d.platform)));
  if (!chatBox) return;
  for (const r of [...chatBox.children]) {
    if ((d.id && r.dataset.id === d.id) || (d.userId && r.dataset.user === d.platform + ':' + d.userId) ||
        (!d.id && !d.userId && r.dataset.platform === d.platform)) r.remove();
  }
});
CB.on('pinned', (d) => { pinnedId = d.event ? d.event.id : null; markPinned(); });
CB.on('error', (d) => toast(d.text));
CB.connect();
