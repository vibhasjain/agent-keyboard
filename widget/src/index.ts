// Mount entry. One <script> tag per page:
//   <script src="https://<fly-app>/widget.js" data-site="cv" defer></script>
// Renders a collapsed bar synchronously; makes ZERO network requests at boot
// unless there is a persisted active job AND a stored session to re-attach with.

import { initAuth } from './auth'
import { mountBar } from './bar'
import { initConfig } from './config'
import { bootRehydrate } from './jobstore'
import { STYLES } from './styles'
import { initViewport } from './viewport'

declare global {
  interface Window {
    __agentKeyboard?: boolean
  }
}

const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@1&family=JetBrains+Mono:wght@400;500&display=swap'

function injectFonts(): void {
  if (document.getElementById('ak-fonts')) return
  const pre1 = document.createElement('link')
  pre1.rel = 'preconnect'
  pre1.href = 'https://fonts.googleapis.com'
  const pre2 = document.createElement('link')
  pre2.rel = 'preconnect'
  pre2.href = 'https://fonts.gstatic.com'
  pre2.crossOrigin = 'anonymous'
  const link = document.createElement('link')
  link.id = 'ak-fonts'
  link.rel = 'stylesheet'
  link.href = FONTS_HREF
  document.head.append(pre1, pre2, link)
}

function mount(): void {
  const host = document.createElement('div')
  host.id = 'agent-keyboard-host'
  host.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:2147483000;pointer-events:none;'
  document.body.appendChild(host)

  const shadow = host.attachShadow({ mode: 'open' })
  injectFonts() // Google Fonts <link> must be in document.head (won't load from shadow DOM)
  const style = document.createElement('style')
  style.textContent = STYLES
  shadow.appendChild(style)

  initViewport(host)
  initAuth() // synchronous: sets auth slice from localStorage, no network
  mountBar(shadow)
  bootRehydrate() // re-attach only if active-job key + stored session exist
}

;(function boot(): void {
  if (window.__agentKeyboard) return
  const script = document.currentScript as HTMLScriptElement | null
  const site = initConfig(script)
  if (!site) {
    console.warn('[agent-keyboard] missing data-site attribute — not mounting')
    return
  }
  window.__agentKeyboard = true
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
})()
