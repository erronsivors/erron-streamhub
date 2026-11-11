// Готовые наборы шаблонов алертов: выбираются при создании шаблона и дальше правятся в конструкторе.
import type { AlertTemplate, Keyframe } from '../../main/core/templates'
import { makeLayer } from './pages/AlertEditor'

export interface AlertPreset {
  id: string
  name: string
  desc: string
  make(): AlertTemplate
}

const uid = (): string => crypto.randomUUID()
const kf = (t: number, x: number, y: number, ease: Keyframe['ease'] = 'inout'): Keyframe => ({ t, x, y, scale: 1, rotate: 0, opacity: 1, ease })

export const PRESETS: AlertPreset[] = [
  {
    id: 'general',
    name: 'Общий',
    desc: 'Аккуратная карточка с иконкой — подходит любому каналу.',
    make: () => ({
      id: uid(), name: 'Общий', theme: 'general', durationMs: 6000, extendByMessage: true,
      layers: [makeLayer('card'), makeLayer('sound', { sound: 'coin', volume: 75 })]
    })
  },
  {
    id: 'campfire',
    name: 'У костра',
    desc: 'Тёплая карточка с мягким свечением, медленно поднимается, звук костра.',
    make: () => ({
      id: uid(), name: 'У костра', theme: 'campfire', durationMs: 7000, extendByMessage: true,
      layers: [
        makeLayer('card', { animIn: 'up', animInMs: 650, animOutMs: 600, keyframes: [kf(0, 260, 212), kf(7000, 260, 196)] }),
        makeLayer('sound', { sound: 'fire', volume: 70 })
      ]
    })
  },
  {
    id: 'minimal',
    name: 'Минимал',
    desc: 'Две строки текста в углу экрана, без подложки — не мешает игре.',
    make: () => ({
      id: uid(), name: 'Минимал', theme: 'auto', durationMs: 5500, extendByMessage: true,
      layers: [
        makeLayer('text', { name: 'Ник и сумма', text: '{user}   {amount}', font: 'manrope', size: 48, align: 'left', x: 96, y: 860, w: 1500, h: 72, animIn: 'right', animInMs: 500 }),
        makeLayer('text', { name: 'Сообщение', text: '{message}', font: 'manrope', size: 30, bold: false, color: '#dcdce4', align: 'left', x: 96, y: 936, w: 1500, h: 96, start: 150, animIn: 'right', animInMs: 500 }),
        makeLayer('sound', { sound: 'pop', volume: 60 })
      ]
    })
  },
  {
    id: 'big',
    name: 'Крупный текст',
    desc: 'Большой ник и сумма по центру экрана — для заметных донатов.',
    make: () => ({
      id: uid(), name: 'Крупный текст', theme: 'auto', durationMs: 6500, extendByMessage: true,
      layers: [
        makeLayer('text', { name: 'Ник', text: '{user}', font: 'unbounded', size: 104, x: 120, y: 300, w: 1680, h: 150, animIn: 'zoom', animInMs: 550 }),
        makeLayer('text', { name: 'Сумма', text: '{amount}', font: 'unbounded', size: 84, x: 120, y: 455, w: 1680, h: 120, start: 250, animIn: 'up', animInMs: 500 }),
        makeLayer('text', { name: 'Сообщение', text: '{message}', font: 'manrope', size: 36, bold: false, color: '#e6e6ec', x: 260, y: 600, w: 1400, h: 150, start: 450, animIn: 'fade', animInMs: 500 }),
        makeLayer('sound', { sound: 'fanfare', volume: 70 })
      ]
    })
  }
]
