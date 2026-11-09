'use strict';
const stage = document.getElementById('stage');
const queue = [];
let busy = false;
const KIND = {
  donation: ['₽', 'Новый донат'], sub: ['★', 'Подписка'], gift: ['🎁', 'Подарочные подписки'], follow: ['♥', 'Новый фолловер'],
  raid: ['↗', 'Рейд'], bits: ['◆', 'Биты'], reward: ['✦', 'Награда за баллы']
};

function amountText(e) {
  if (!e.amount) return '';
  if (e.type === 'donation') return e.amount.toLocaleString('ru-RU') + ' ' + (e.currency === 'RUB' ? '₽' : (e.currency || ''));
  if (e.type === 'bits') return e.amount + ' бит';
  return '';
}

function render(e) {
  const k = KIND[e.type] || ['!', e.type];
  const box = CB.el('div', 'alert card');
  box.append(CB.el('div', 'icon', k[0]));
  const body = CB.el('div');
  const kicker = CB.el('div', 'kicker', k[1]);
  if (e.test) kicker.append(CB.el('span', 'test', 'ТЕСТ'));
  const who = CB.el('div', 'who', e.user);
  const amt = amountText(e);
  if (amt) who.append(CB.el('span', 'amt grad', amt));
  body.append(kicker, who);
  if (e.text) body.append(CB.el('div', 'text', e.text));
  box.append(body);
  return box;
}

async function playNext() {
  if (busy || !queue.length) return;
  busy = true;
  const e = queue.shift();
  const box = render(e);
  stage.replaceChildren(box);
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('show')));
  await new Promise((r) => setTimeout(r, 5000 + Math.min((e.text || '').length * 40, 5000)));
  box.classList.remove('show');
  await new Promise((r) => setTimeout(r, 600));
  stage.replaceChildren();
  busy = false;
  setTimeout(playNext, 400);
}

CB.on('hello', (d) => CB.theme(d.overlays.alert.theme));
CB.on('config', (d) => CB.theme(d.overlays.alert.theme));
CB.on('event', (d) => {
  const e = d.event;
  if (!e || e.type === 'message' || e.type === 'system') return;
  queue.push(e);
  playNext();
});
CB.connect();
