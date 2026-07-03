// Mount entry. One <script> tag per page:
//   <script src="https://<fly-app>/widget.js" data-site="cv" defer></script>
// Renders a collapsed bar synchronously; makes ZERO network requests at boot
// unless there is a persisted active job AND a stored session to re-attach with.

import { initAuth } from './auth'
import { mountBar } from './bar'
import { initConfig } from './config'
import { injectFonts } from './fonts'
import { bootRehydrate } from './jobstore'
import { STYLES } from './styles'
import { initViewport } from './viewport'

declare global {
  interface Window {
    __agentKeyboard?: boolean
  }
}

// No browser zoom from inside the widget, ever: double-tapping the bar or
// pinching over it must never scale the host page. touch-action CSS covers
// modern engines; iOS Safari's proprietary gesture events need explicit
// preventDefault, and rapid double-taps on non-interactive surfaces are eaten.
function blockZoomGestures(el: HTMLElement): void {
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    el.addEventListener(ev, (e) => e.preventDefault())
  }
  let lastTouchEnd = 0
  el.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now()
      const t = e.target as HTMLElement | null
      const interactive = !!t?.closest('button, textarea, input, a')
      if (now - lastTouchEnd < 350 && !interactive) e.preventDefault()
      lastTouchEnd = now
    },
    { passive: false },
  )
}

function mount(): void {
  const host = document.createElement('div')
  host.id = 'agent-keyboard-host'
  host.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:2147483000;pointer-events:none;'
  document.body.appendChild(host)
  blockZoomGestures(host)

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
