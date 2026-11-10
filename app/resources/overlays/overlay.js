// Crossember — общий код оверлеев и пульта.
// Безопасность: пользовательский текст выводится ТОЛЬКО через textContent / text-узлы,
// картинки — только по https-URL, которые ядро собрало из проверенных ID.
'use strict';
const CB = (() => {
  const key = new URLSearchParams(location.search).get('k') || '';
  const handlers = {};
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const img = (url, cls, alt) => {
    // Только картинки из локального кэша Crossember: /e/<hash>.
    if (typeof url !== 'string' || !/^\/e\/[0-9a-f]{32}$/.test(url)) return document.createTextNode(alt || '');
    const i = el('img', cls);
    i.src = url;
    i.alt = alt || '';
    i.referrerPolicy = 'no-referrer';
    return i;
  };
  const parts = (msg) => {
    const f = document.createDocumentFragment();
    if (Array.isArray(msg.parts) && msg.parts.length) {
      for (const p of msg.parts) f.append(p.t === 'emote' ? img(p.url, 'emote', p.v) : document.createTextNode(p.v));
    } else f.append(document.createTextNode(msg.text || ''));
    return f;
  };
  /** Строка чата: [платформа] [бейджи] Ник: сообщение */
  const line = (m, opts) => {
    const row = el('div', 'msg');
    row.dataset.id = m.id;
    if (m.userId) row.dataset.user = m.platform + ':' + m.userId;
    row.dataset.platform = m.platform;
    if (opts.showPlatform) row.append(el('span', 'plat p-' + m.platform));
    if (opts.showBadges && Array.isArray(m.badges)) for (const b of m.badges) row.append(img(b.url, 'badge', b.title));
    const name = el('span', 'name', m.user);
    if (m.color && /^#[0-9a-fA-F]{6}$/.test(m.color)) name.style.color = m.color;
    row.append(name, el('span', 'sep', ': '));
    const text = el('span', 'text');
    text.append(parts(m));
    row.append(text);
    return row;
  };
  const theme = (t) => {
    document.body.classList.remove('t-general', 't-campfire');
    document.body.classList.add(t === 'campfire' ? 't-campfire' : 't-general');
  };
  const on = (kind, fn) => { handlers[kind] = fn; };
  const api = { el, img, parts, line, theme, on, key, build: '', connect: null, send: null, ws: null };
  api.connect = () => {
    const ws = new WebSocket('ws://' + location.host + '/ws?k=' + encodeURIComponent(key));
    ws.onmessage = (m) => {
      let d;
      try { d = JSON.parse(m.data); } catch { return; }
      // Новая версия Crossember — перезагрузить страницу, чтобы OBS взял свежий код оверлея.
      if (d.kind === 'hello' && d.build) {
        if (api.build && api.build !== d.build) { location.reload(); return; }
        api.build = d.build;
      }
      (handlers[d.kind] || (() => {}))(d);
    };
    ws.onclose = (c) => {
      (handlers.closed || (() => {}))(c);
      if (c.code !== 4003) setTimeout(api.connect, 2000);
    };
    ws.onopen = () => (handlers.open || (() => {}))();
    api.ws = ws;
  };
  api.send = (obj) => { if (api.ws && api.ws.readyState === 1) api.ws.send(JSON.stringify(obj)); };
  return api;
})();
