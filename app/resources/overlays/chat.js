'use strict';
// Чат-оверлей. Режим по data-mode на <body>:
//   v — вертикальный, h — горизонтальный (новые слева), f — окно «чат поверх игры».
// Оформление (CSS) собирает ядро из настроек — тот же CSS, что в предпросмотре Crossember.
// Безопасность: текст только через textContent, картинки — только из кэша Crossember (/e/<hash>).
const list = document.getElementById('list');
const mode = document.body.dataset.mode;
const horizontal = mode === 'h';
const styleEl = document.createElement('style');
document.head.append(styleEl);
let opts = null;
let own = [];

const TAG = { twitch: 'Tw', youtube: 'YT', vk: 'VK', kick: 'K', goodgame: 'GG', donationalerts: 'DA', donatepay: 'DP', donatex: 'DX', boosty: 'B', hub: '₽' };
const CHAT_SOURCES = ['twitch', 'youtube', 'vk', 'kick', 'goodgame'];
const hexOk = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

function apply(overlays) {
  opts = mode === 'h' ? overlays.chatH : mode === 'f' ? overlays.float : overlays.chat;
  CB.theme(opts.theme);
  document.body.style.setProperty('--fs', opts.fontSize + 'px');
  list.classList.toggle('top', mode !== 'h' && !!opts.look.newestTop);
  trim();
}

function applyStyle(cs) {
  if (!cs) return;
  own = Array.isArray(cs.own) ? cs.own : [];
  const key = mode === 'h' ? 'chatH' : mode === 'f' ? 'float' : 'chat';
  styleEl.textContent = (cs.css && cs.css[key]) || '';
}

const newestFirst = () => horizontal || (opts && opts.look.newestTop);

function trim() {
  if (!opts) return;
  while (list.children.length > opts.maxMessages) {
    if (newestFirst()) list.lastElementChild.remove();
    else list.firstElementChild.remove();
  }
}

function mention(text) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
  return own.some((o) => {
    const n = String(o).toLowerCase().replace(/ё/g, 'е').replace(/^@/, '');
    if (n.length < 2) return false;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^\\p{L}\\p{N}_])@?' + esc + '($|[^\\p{L}\\p{N}_])', 'u').test(t);
  });
}

function platOk(p) {
  const pl = opts.look.platforms;
  return !CHAT_SOURCES.includes(p) || !pl.length || pl.includes(p);
}

function visible(m, view) {
  if (m.type === 'message') return platOk(m.platform);
  if (m.type === 'system') return opts.showStatus;
  return !!view && !!opts.look.events[view.kind] && platOk(m.platform);
}

function platSpan(p) {
  const s = CB.el('span', 'plat', opts.look.plat === 'tag' ? (TAG[p] || '') : '');
  const c = opts.look.colors[p];
  if (hexOk(c)) s.style.setProperty('--pc', c);
  return s;
}

function textNode(m) {
  if (opts.look.showEmotes) return CB.parts(m);
  return document.createTextNode(m.text || '');
}

function messageRow(m) {
  const look = opts.look;
  const row = CB.el('div', 'msg');
  row.dataset.id = m.id;
  if (m.userId) row.dataset.user = m.platform + ':' + m.userId;
  row.dataset.platform = m.platform;
  if (look.events.mention && mention(m.text)) row.classList.add('mention');
  if (opts.showPlatform) row.append(platSpan(m.platform));
  if (opts.showBadges && Array.isArray(m.badges)) for (const b of m.badges) row.append(CB.img(b.url, 'badge', b.title));
  if (look.showName) {
    const name = CB.el('span', 'name', m.user);
    if (look.textMode === 'split' && look.name.color) name.classList.add('fixed');
    else if (hexOk(m.color)) name.style.color = m.color;
    if (!look.sep) name.classList.add('nosep');
    row.append(name);
    if (look.sep) row.append(CB.el('span', 'sep', look.sep));
  }
  const text = CB.el('span', 'text');
  text.append(textNode(m));
  row.append(text);
  return row;
}

function eventRow(m, view) {
  const look = opts.look;
  const row = CB.el('div', 'msg ev ev-' + view.kind);
  row.dataset.id = m.id;
  row.dataset.platform = m.platform;
  const c = look.colors[view.color];
  if (hexOk(c)) { row.style.setProperty('--ec', c); row.style.setProperty('--ecf', c + '4d'); }
  const head = CB.el('div', 'ev-head');
  if (opts.showPlatform) head.append(platSpan(m.platform));
  head.append(CB.el('span', 'name', m.user), CB.el('span', 'ev-label', view.icon + ' ' + view.label));
  if (view.detail) head.append(CB.el('span', 'ev-detail', view.detail));
  row.append(head);
  if (view.body) {
    const body = CB.el('div', 'ev-body');
    body.append(CB.el('span', 'text', view.body));
    row.append(body);
  }
  return row;
}

function add(m, view, animate) {
  let row;
  if (m.type === 'system') {
    row = CB.el('div', 'msg system', m.text);
    row.dataset.platform = m.platform;
  } else if (m.type === 'message') row = messageRow(m);
  else row = eventRow(m, view);
  if (!animate) row.classList.add('still');
  if (newestFirst()) list.prepend(row);
  else list.append(row);
  trim();
  if (opts.hideAfterSec > 0) {
    setTimeout(() => {
      row.classList.remove('still');
      row.classList.add('gone');
      setTimeout(() => row.remove(), (opts.look.animMs || 300) + 80);
    }, opts.hideAfterSec * 1000);
  }
}

CB.on('hello', (d) => {
  apply(d.overlays);
  applyStyle(d.chatStyle);
  list.replaceChildren();
  // Последние сообщения и события при перезапуске источника — только те, что ещё не должны были исчезнуть.
  const now = Date.now();
  const all = [...(d.chat || []).map((m) => ({ m, view: null })), ...(d.events || []).filter((e) => e.type !== 'message' && e.type !== 'system').map((e) => ({ m: e, view: e.view || null }))]
    .filter((x) => visible(x.m, x.view) && (opts.hideAfterSec === 0 || now - x.m.ts < opts.hideAfterSec * 1000))
    .sort((a, b) => b.m.ts - a.m.ts)
    .slice(0, opts.maxMessages)
    .reverse();
  for (const x of all) add(x.m, x.view, false);
});
CB.on('config', (d) => { apply(d.overlays); applyStyle(d.chatStyle); });
CB.on('event', (d) => { if (opts && d.event && visible(d.event, d.view)) add(d.event, d.view, true); });
CB.on('chattest', (d) => { if (opts && d.event && visible(d.event, d.view)) add(d.event, d.view, true); });
CB.on('delete', (d) => {
  for (const row of [...list.children]) {
    const byId = d.id && row.dataset.id === d.id;
    const byUser = d.userId && row.dataset.user === d.platform + ':' + d.userId;
    const byPlatform = !d.id && !d.userId && d.platform && row.dataset.platform === d.platform && !row.classList.contains('system');
    if (byId || byUser || byPlatform) row.remove();
  }
});
CB.connect();
