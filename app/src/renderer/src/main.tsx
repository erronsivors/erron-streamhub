import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/unbounded/700.css'
import '@fontsource/unbounded/800.css'
import '@fontsource/manrope/500.css'
import '@fontsource/manrope/600.css'
import '@fontsource/manrope/700.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles.css'
import './editor.css'
import { App } from './App'

// Ошибки интерфейса — в журнал Crossember (для разбора у друзей).
window.addEventListener('error', (e) => {
  void window.hub.logError(`${e.message} @ ${e.filename?.split('/').pop() ?? ''}:${e.lineno}:${e.colno}${e.error?.stack ? ' | ' + String(e.error.stack).split('\n').slice(1, 6).join(' | ') : ''}`).catch(() => undefined)
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: string; stack?: string } | undefined
  void window.hub.logError(`Необработанная ошибка: ${r?.stack ?? r?.message ?? String(e.reason)}`).catch(() => undefined)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
