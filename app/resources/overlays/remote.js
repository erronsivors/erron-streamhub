'use strict';
// Чат для второго (игрового) ПК: читать чат и события, писать в чат, закреплять сообщения.
const chat = document.getElementById('chat');
const evlist = document.getElementById('evlist');
const st = document.getElementById('st');
const err = document.getElementById('err');
const opts = { showBadges: true, showPlatform: true };
let pinnedId = null;
const LABEL = { donation: 'донат', follow: 'фоллоу', sub: 'подписка', gift: 'подарочные подписки', raid: 'рейд', bits: 'биты', reward: 'награда' };

function atBottom() { return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40; }

function addMsg(m) {
  const stick = atBottom();
  const row = CB.line(m, opts);
  if (m.id === pinnedId) row.classList.add('pinned');
  row.addEventListener('click', () => CB.send({ kind: 'pin', id: m.id }));
  chat.append(row);
  while (chat.children.length > 300) chat.firstElementChild.remove();
  if (stick) chat.scrollTop = chat.scrollHeight;
}

function addEvent(e, top) {
  const box = CB.el('div', 'ev card');
  let title = e.user + ' · ' + (LABEL[e.type] || e.type);
  if (e.type === 'donation' && e.amount) title += ' · ' + e.amount + ' ' + (e.currency || '');
  box.append(CB.el('b', null, title));
  if (e.text) box.append(CB.el('small', null, e.text));
  if (top) evlist.prepend(box); else evlist.append(box);
  while (evlist.children.length > 50) evlist.lastElementChild.remove();
}

function markPinned() {
  for (const row of chat.children) row.classList.toggle('pinned', row.dataset.id === pinnedId);
}

CB.on('open', () => { st.textContent = 'подключено'; });
CB.on('closed', (c) => { st.textContent = c.code === 4003 ? 'нет доступа — ссылка устарела' : 'нет связи с Crossember…'; });
CB.on('hello', (d) => {
  CB.theme(d.overlays.chat.theme);
  chat.replaceChildren();
  evlist.replaceChildren();
  pinnedId = d.pinned ? d.pinned.id : null;
  for (const m of d.chat.slice().reverse()) addMsg(m);
  for (const e of d.events) addEvent(e, false);
  chat.scrollTop = chat.scrollHeight;
});
CB.on('config', (d) => CB.theme(d.overlays.chat.theme));
CB.on('event', (d) => {
  const e = d.event;
  if (!e) return;
  if (e.type === 'message') addMsg(e); else if (e.type !== 'system') addEvent(e, true);
});
CB.on('delete', (d) => {
  for (const row of [...chat.children]) {
    if ((d.id && row.dataset.id === d.id) || (d.userId && row.dataset.user === d.platform + ':' + d.userId) ||
        (!d.id && !d.userId && row.dataset.platform === d.platform)) row.remove();
  }
});
CB.on('pinned', (d) => { pinnedId = d.event ? d.event.id : null; markPinned(); });
CB.on('error', (d) => { err.textContent = d.text; setTimeout(() => { err.textContent = ''; }, 6000); });

document.getElementById('f').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const t = document.getElementById('t');
  const text = t.value.trim();
  if (!text) return;
  CB.send({ kind: 'send', text });
  t.value = '';
});
CB.connect();
