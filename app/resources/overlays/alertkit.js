// Crossember — движок показа алертов из слоёв (конструктор). Один и тот же файл работает
// в оверлее OBS и в редакторе приложения (предпросмотр и перемотка), поэтому в редакторе видно ровно то, что будет в эфире.
// Безопасность: текст — только textContent, ссылки на файлы — только наши /m/ /s/ /t/ по строгому шаблону, цвета — только #RRGGBB.
'use strict';
(function () {
  const W = 1920, H = 1080;
  const CSS_EASE = { linear: 'linear', ease: 'ease', in: 'ease-in', out: 'ease-out', inout: 'ease-in-out', back: 'cubic-bezier(.2,.9,.3,1.35)' };
  const EASE_FN = {
    linear: (p) => p,
    ease: (p) => p * p * (3 - 2 * p),
    in: (p) => p * p,
    out: (p) => 1 - (1 - p) * (1 - p),
    inout: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
    back: (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
  };
  const FONT = { manrope: "'Manrope', sans-serif", unbounded: "'Unbounded', sans-serif", mono: "'JetBrains Mono', monospace" };
  const ICON = { donation: '₽', sub: '★', gift: '🎁', follow: '♥', raid: '↗', bits: '◆', reward: '✦', message: '💬' };
  const SRC_RE = /^\/(m\/[0-9a-f]{32}\.(png|jpg|gif|webp|webm|mp4)|s\/[0-9a-f]{32}\.(mp3|wav|ogg)|t\/[0-9a-f]{40}\.wav)$/;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  /** Сколько длится слой: duration 0 — до конца алерта. */
  function layerDur(l, total) {
    return l.duration > 0 ? l.duration : Math.max(0, total - l.start);
  }

  /** Состояние слоя (позиция, масштаб, поворот, прозрачность) через t мс от его начала. */
  function sample(l, t) {
    const k = Array.isArray(l.keyframes) ? l.keyframes : [];
    if (!k.length) return { x: l.x, y: l.y, scale: 1, rotate: l.rotate, opacity: l.opacity };
    if (t <= k[0].t) return pick(k[0]);
    const last = k[k.length - 1];
    if (t >= last.t) return pick(last);
    for (let i = 0; i < k.length - 1; i++) {
      const a = k[i], b = k[i + 1];
      if (t >= a.t && t <= b.t) {
        const p = b.t === a.t ? 1 : (EASE_FN[a.ease] || EASE_FN.ease)((t - a.t) / (b.t - a.t));
        const lerp = (x, y) => x + (y - x) * p;
        return { x: lerp(a.x, b.x), y: lerp(a.y, b.y), scale: lerp(a.scale, b.scale), rotate: lerp(a.rotate, b.rotate), opacity: lerp(a.opacity, b.opacity) };
      }
    }
    return pick(last);
  }
  const pick = (f) => ({ x: f.x, y: f.y, scale: f.scale, rotate: f.rotate, opacity: f.opacity });
  const transform = (s) => `translate(${s.x}px, ${s.y}px) rotate(${s.rotate}deg) scale(${s.scale})`;

  /** Пресеты появления: состояние «до» (для исчезновения — «после»). */
  const PRESET = {
    fade: { opacity: 0 },
    up: { opacity: 0, transform: 'translateY(90px)' },
    down: { opacity: 0, transform: 'translateY(-90px)' },
    left: { opacity: 0, transform: 'translateX(140px)' },
    right: { opacity: 0, transform: 'translateX(-140px)' },
    zoom: { opacity: 0, transform: 'scale(.55)' },
    pop: { opacity: 0, transform: 'scale(.8)' },
    spin: { opacity: 0, transform: 'rotate(-180deg) scale(.4)' }
  };
  const IDENT = { opacity: 1, transform: 'none' };

  function presetFrames(name, out) {
    const p = PRESET[name];
    if (!p) return null;
    const from = { opacity: p.opacity, transform: p.transform || 'none' };
    if (name === 'pop' && !out) return [from, { opacity: 1, transform: 'scale(1.06)', offset: 0.7 }, IDENT];
    return out ? [IDENT, from] : [from, IDENT];
  }

  function textParts(box, parts, l) {
    for (const p of parts || []) {
      if (p.t === 'amount') {
        const s = el('span', l.accent && COLOR_RE.test(l.accent) ? 'ak-amt' : 'ak-amt ak-grad', p.v);
        if (l.accent && COLOR_RE.test(l.accent)) s.style.color = l.accent;
        box.append(s);
      } else box.append(document.createTextNode(String(p.v)));
    }
  }

  /** Содержимое слоя (без позиции и анимаций). */
  function content(l, item, opts) {
    const box = el('div', 'ak-content ak-c-' + l.type);
    box.style.justifyContent = l.align === 'left' ? 'flex-start' : l.align === 'right' ? 'flex-end' : 'center';
    if (l.type === 'card') {
      const card = el('div', 'ak-card k-' + item.kind);
      card.style.setProperty('--s', String(num(l.size, 56) / 56));
      card.append(el('div', 'ak-icon', ICON[item.kind] || '!'));
      const body = el('div', 'ak-body');
      const kicker = el('div', 'ak-kicker', l.kickerText || '');
      if (item.test) kicker.append(el('span', 'ak-test', 'ТЕСТ'));
      const who = el('div', 'ak-who');
      textParts(who, l.parts, l);
      body.append(kicker, who);
      if (l.message) body.append(el('div', 'ak-text', l.message));
      card.append(body);
      box.append(card);
    } else if (l.type === 'text') {
      const t = el('div', 'ak-txt');
      t.style.fontFamily = FONT[l.font] || FONT.manrope;
      t.style.fontSize = num(l.size, 56) + 'px';
      t.style.fontWeight = l.bold ? '800' : '600';
      t.style.textAlign = l.align || 'center';
      if (COLOR_RE.test(l.color)) t.style.color = l.color;
      if (l.shadow) t.style.textShadow = '0 4px 18px rgba(0,0,0,.65), 0 1px 3px rgba(0,0,0,.8)';
      if (l.stroke > 0) t.style.webkitTextStroke = Math.min(20, l.stroke) + 'px #000';
      textParts(t, l.parts, l);
      box.append(t);
    } else if ((l.type === 'image' || l.type === 'video') && typeof l.src === 'string' && SRC_RE.test(l.src)) {
      const m = el(l.type === 'image' ? 'img' : 'video', 'ak-media');
      m.style.objectFit = l.fit === 'cover' || l.fit === 'fill' ? l.fit : 'contain';
      if (l.type === 'video') {
        m.muted = !(l.vol > 0) || !!opts.paused || (opts.canSound ? !opts.canSound() : false);
        m.volume = Math.min(1, Math.max(0, num(l.vol, 0)));
        m.loop = !!l.loop;
        m.playsInline = true;
        m.preload = 'auto';
      } else m.alt = '';
      m.src = opts.url(l.src);
      box.append(m);
    } else if (opts.editor && l.type !== 'sound' && l.type !== 'tts' && l.type !== 'obs') {
      box.append(el('div', 'ak-empty', l.type === 'image' ? 'Выберите картинку' : 'Выберите видео'));
    }
    return box;
  }

  /**
   * Показать алерт на сцене. opts: url(src) → полный адрес; theme; paused (для перемотки в редакторе);
   * playBuiltin(id, volume) — встроенные звуки; editor — подсказки в пустых слоях;
   * canSound() — можно ли сейчас играть звук (оверлей: только «главная» видимая копия и не опоздавший алерт).
   * Возвращает { seek(t), pause(), resume(t), stop(), duration }.
   */
  function mount(stage, item, opts) {
    opts = opts || {};
    const total = num(item.durationMs, 6000);
    const theme = item.theme === 'general' || item.theme === 'campfire' ? item.theme : opts.theme === 'campfire' ? 'campfire' : 'general';
    stage.classList.add('ak-stage');
    stage.classList.remove('t-general', 't-campfire');
    stage.classList.add('t-' + theme);
    stage.replaceChildren();
    const anims = [];
    const timers = [];
    const media = [];
    const sounds = [];
    let stopped = false;
    let held = false;
    // Оверлей подключился посреди алерта: таймеры звуков и видео — от этого места, начавшееся раньше не запускается.
    const off = Math.max(0, num(opts.offset, 0));

    for (const l of item.layers || []) {
      const start = num(l.start, 0);
      const dur = layerDur(l, total);
      if (dur <= 0) continue;
      if (l.type === 'sound' || l.type === 'tts') {
        if (opts.paused || start < off) continue;
        timers.push(setTimeout(() => {
          if (stopped || held || (opts.canSound && !opts.canSound())) return;
          const vol = Math.min(1, Math.max(0, num(l.vol, 0)));
          if (!(vol > 0)) return;
          if (l.builtin && opts.playBuiltin) return opts.playBuiltin(l.builtin, vol);
          if (typeof l.src === 'string' && SRC_RE.test(l.src)) {
            const a = new Audio(opts.url(l.src));
            a.volume = vol;
            a.play().catch(() => {});
            sounds.push(a);
          }
        }, start - off));
        continue;
      }
      if (l.type === 'obs') continue;

      const wrap = el('div', 'ak-layer');
      wrap.dataset.id = l.id;
      wrap.style.width = l.w + 'px';
      wrap.style.height = l.h + 'px';
      const inner = el('div', 'ak-inner');
      inner.append(content(l, item, opts));
      wrap.append(inner);
      stage.append(wrap);

      // Видимость — только пока слой «идёт» на таймлайне.
      anims.push(wrap.animate([{ visibility: 'visible' }, { visibility: 'visible' }], { duration: dur, delay: start, fill: 'none' }));
      // Позиция и движение по ключевым кадрам.
      const k = Array.isArray(l.keyframes) ? l.keyframes : [];
      if (k.length) {
        const frames = [];
        const at = (f, offset) => ({ offset, transform: transform(f), opacity: f.opacity, easing: CSS_EASE[f.ease] || 'ease' });
        if (k[0].t > 0) frames.push(at(k[0], 0));
        for (const f of k) frames.push(at(f, Math.min(1, Math.max(0, f.t / dur))));
        if (k[k.length - 1].t < dur) frames.push(at(k[k.length - 1], 1));
        for (let i = 1; i < frames.length; i++) if (frames[i].offset < frames[i - 1].offset) frames[i].offset = frames[i - 1].offset;
        anims.push(wrap.animate(frames, { duration: dur, delay: start, fill: 'both' }));
      } else {
        wrap.style.transform = transform(sample(l, 0));
        wrap.style.opacity = String(l.opacity);
      }
      // Появление и исчезновение.
      const inF = presetFrames(l.animIn, false);
      const inMs = Math.min(num(l.animInMs, 450), dur);
      if (inF && inMs > 0) anims.push(inner.animate(inF, { duration: inMs, delay: start, fill: 'backwards', easing: l.animIn === 'pop' ? 'ease-out' : 'cubic-bezier(.2,.8,.3,1)' }));
      const outF = presetFrames(l.animOut, true);
      const outMs = Math.min(num(l.animOutMs, 450), dur);
      if (outF && outMs > 0) anims.push(inner.animate(outF, { duration: outMs, delay: start + dur - outMs, fill: 'forwards', easing: 'ease-in' }));

      const vid = inner.querySelector('video');
      if (vid) {
        media.push({ v: vid, start });
        if (!opts.paused && start >= off) timers.push(setTimeout(() => { if (!stopped && !held) { vid.currentTime = 0; vid.play().catch(() => {}); } }, start - off));
      }
    }

    const handle = {
      duration: total,
      /** Перемотка (редактор): показать кадр в момент t. */
      seek(t) {
        for (const a of anims) { a.pause(); a.currentTime = Math.max(0, t); }
        for (const m of media) {
          m.v.pause();
          const local = Math.max(0, (t - m.start) / 1000);
          if (isFinite(m.v.duration) && m.v.duration > 0) m.v.currentTime = m.v.loop ? local % m.v.duration : Math.min(local, m.v.duration - 0.05);
        }
      },
      /** Пауза (источник скрыт): движение и видео стоят, звук не начинается. */
      pause() {
        held = true;
        for (const a of anims) a.pause();
        for (const m of media) m.v.pause();
        for (const a of sounds) a.pause();
      },
      /** Продолжить с момента t (сколько прошло от начала алерта по часам ядра). */
      resume(t) {
        held = false;
        for (const a of anims) { a.currentTime = Math.max(0, t); a.play(); }
        for (const m of media) {
          if (t < m.start) continue;
          const local = (t - m.start) / 1000;
          if (isFinite(m.v.duration) && m.v.duration > 0) {
            if (!m.v.loop && local >= m.v.duration) continue;
            m.v.currentTime = m.v.loop ? local % m.v.duration : local;
          }
          m.v.play().catch(() => {});
        }
      },
      stop() {
        stopped = true;
        for (const t of timers) clearTimeout(t);
        for (const a of sounds) a.pause();
        for (const m of media) m.v.pause();
        for (const a of anims) a.cancel();
        stage.replaceChildren();
      }
    };
    if (opts.paused) handle.seek(num(opts.startAt, 0));
    else if (off > 0) handle.resume(off);
    return handle;
  }

  const api = { W, H, mount, sample, layerDur, transform, EASE_FN };
  if (typeof window !== 'undefined') window.AlertKit = api;
})();
