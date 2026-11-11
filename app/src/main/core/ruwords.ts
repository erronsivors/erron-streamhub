/**
 * Числа словами по-русски — для озвучки («пятьсот рублей», «двадцать одна гривна»).
 * Нужно голосам, которые не умеют читать цифры сами (Silero), и полезно для Windows-голосов: правильный род и падеж.
 */

export type Gender = 'm' | 'f' | 'n'

const ONES_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const ONES_N = ['', 'одно', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать']
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто']
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот']

/** Разряды: тысяча — женского рода, остальные — мужского. */
const SCALES: { forms: [string, string, string]; gender: Gender }[] = [
  { forms: ['тысяча', 'тысячи', 'тысяч'], gender: 'f' },
  { forms: ['миллион', 'миллиона', 'миллионов'], gender: 'm' },
  { forms: ['миллиард', 'миллиарда', 'миллиардов'], gender: 'm' }
]

/** Форма слова для числа: 1 рубль, 2 рубля, 5 рублей. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.trunc(n)) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b > 1 && b < 5) return few
  if (b === 1) return one
  return many
}

function triad(n: number, g: Gender): string[] {
  const out: string[] = []
  const h = Math.floor(n / 100)
  const t = Math.floor((n % 100) / 10)
  const o = n % 10
  if (h) out.push(HUNDREDS[h])
  if (t === 1) out.push(TEENS[o])
  else {
    if (t) out.push(TENS[t])
    if (o) out.push((g === 'f' ? ONES_F : g === 'n' ? ONES_N : ONES_M)[o])
  }
  return out
}

/** Целое число словами (0 … 999 999 999 999). Больше — возвращается цифрами. */
export function numberWords(value: number, gender: Gender = 'm'): string {
  const n = Math.trunc(Math.abs(value))
  if (!Number.isFinite(n) || n > 999_999_999_999) return String(value)
  if (n === 0) return 'ноль'
  const words: string[] = []
  const groups: number[] = []
  for (let x = n; x > 0; x = Math.floor(x / 1000)) groups.push(x % 1000)
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]
    if (!g) continue
    if (i === 0) words.push(...triad(g, gender))
    else {
      const sc = SCALES[i - 1]
      words.push(...triad(g, sc.gender), plural(g, ...sc.forms))
    }
  }
  return (value < 0 ? 'минус ' : '') + words.join(' ')
}

interface CurrencyWords { main: [string, string, string]; gender: Gender; minor?: { forms: [string, string, string]; gender: Gender } }

const KOPEK = { forms: ['копейка', 'копейки', 'копеек'] as [string, string, string], gender: 'f' as Gender }
const CENT = { forms: ['цент', 'цента', 'центов'] as [string, string, string], gender: 'm' as Gender }

export const CURRENCY_WORDS: Record<string, CurrencyWords> = {
  RUB: { main: ['рубль', 'рубля', 'рублей'], gender: 'm', minor: KOPEK },
  USD: { main: ['доллар', 'доллара', 'долларов'], gender: 'm', minor: CENT },
  EUR: { main: ['евро', 'евро', 'евро'], gender: 'n', minor: CENT },
  UAH: { main: ['гривна', 'гривны', 'гривен'], gender: 'f', minor: KOPEK },
  KZT: { main: ['тенге', 'тенге', 'тенге'], gender: 'm', minor: { forms: ['тиын', 'тиына', 'тиынов'], gender: 'm' } },
  BYN: { main: ['белорусский рубль', 'белорусских рубля', 'белорусских рублей'], gender: 'm', minor: KOPEK }
}

/** Сумма словами: «пятьсот рублей», «двадцать одна гривна пятьдесят копеек». Неизвестная валюта — код после числа. */
export function moneyWords(amount: number, currency = 'RUB'): string {
  const cents = Math.round(Math.abs(amount) * 100)
  const whole = Math.floor(cents / 100)
  const minor = cents % 100
  const c = CURRENCY_WORDS[currency]
  if (!c) return `${numberWords(whole)}${minor ? ` целых ${numberWords(minor, 'f')} сотых` : ''} ${currency}`.trim()
  let s = `${numberWords(whole, c.gender)} ${plural(whole, ...c.main)}`
  if (minor && c.minor) s += ` ${numberWords(minor, c.minor.gender)} ${plural(minor, ...c.minor.forms)}`
  return s
}

/**
 * Все отдельно стоящие числа в тексте — словами: «лови 300 за 2 часа» → «лови триста за два часа».
 * Числа, приклеенные к буквам (ник «Vasya2007»), и слишком длинные (телефоны) не трогаются.
 * «1 000» и «1,5» читаются как одно число («тысяча», «одна целая пять десятых»); даты вроде 10.11.2026 остаются цифрами.
 */
export function numbersToWords(text: string): string {
  return text.replace(/(?<![\p{L}\d]|\d[.,])(\d{1,3}(?:[  ]\d{3})+|\d{1,12})(?:[.,](\d{1,2}))?(?![\p{L}\d]|[.,]\d)/gu, (_m, int: string, frac?: string) => {
    const n = Number(int.replace(/[  ]/g, ''))
    if (!frac) return numberWords(n)
    const f = Number(frac)
    const unit: [string, string, string] = frac.length === 1 ? ['десятая', 'десятых', 'десятых'] : ['сотая', 'сотых', 'сотых']
    return `${numberWords(n, 'f')} ${plural(n, 'целая', 'целых', 'целых')} ${numberWords(f, 'f')} ${plural(f, ...unit)}`
  })
}
