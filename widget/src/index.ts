// Mount entry. One <script> tag per page:
//   <script src="https://<fly-app>/widget.js" data-site="cv" defer></script>
// Renders a collapsed bar synchronously; makes ZERO network requests at boot
// unless there is a persisted active job AND a stored session to re-attach with.

import { consumeInviteToken, getPendingInvite, initAuth } from './auth'
import { mountBar } from './bar'
import { initConfig, shouldMountHere } from './config'
import { injectFonts } from './fonts'
import { isGuestDemo, loadGuestDemo } from './guest-demo'
import { bootRehydrate } from './jobstore'
import { getState, patchUi } from './state'
import { STYLES } from './styles'
import { initViewport } from './viewport'

declare global {
  interface Window {
    // `true` from boot until mount; then the visibility API (host pages that
    // summon the bar with a hotkey use it — see hide() for why display:none
    // alone is not enough).
    __agentKeyboard?: true | { visible(): boolean; show(): void; hide(): void; toggle(): boolean }
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
  if (isGuestDemo()) void loadGuestDemo()
  mountBar(shadow)
  // If we arrived from an invite/recovery link, open the transcript — its footer
  // holds the set-a-password form. Otherwise rest as the corner rectangle.
  if (getPendingInvite()) patchUi({ mode: 'expanded' })
  bootRehydrate() // re-attach only if active-job key + stored session exist

  // Page-controlled visibility. hide() collapses the transcript FIRST: when
  // expanded, chat.ts holds a body scroll lock (position:fixed), and hiding
  // the host without releasing it freezes the page under an invisible widget.
  const api = {
    visible: (): boolean => host.style.display !== 'none',
    show: (): void => {
      host.style.display = ''
    },
    hide: (): void => {
      if (getState().ui.mode === 'expanded') patchUi({ mode: 'mini' })
      host.style.display = 'none'
    },
    toggle: (): boolean => {
      if (api.visible()) api.hide()
      else api.show()
      return api.visible()
    },
  }
  window.__agentKeyboard = api
}

;(function boot(): void {
  if (window.__agentKeyboard) return
  const script = document.currentScript as HTMLScriptElement | null
  const site = initConfig(script)
  if (!site) {
    console.warn('[agent-keyboard] missing data-site attribute — not mounting')
    return
  }
  // Shows on every page the embed is on by default; data-hide-paths /
  // data-only-paths on the <script> tag scope it without editing each page.
  if (!shouldMountHere(script)) return
  consumeInviteToken() // stash + strip any invite/recovery token from the URL hash
  window.__agentKeyboard = true
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
})()
