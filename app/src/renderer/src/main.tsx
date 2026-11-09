import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/unbounded/700.css'
import '@fontsource/unbounded/800.css'
import '@fontsource/manrope/500.css'
import '@fontsource/manrope/600.css'
import '@fontsource/manrope/700.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
