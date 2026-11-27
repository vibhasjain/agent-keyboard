// Mount entry. One <script> tag per page:
//   <script src="https://<fly-app>/widget.js" data-site="cv" defer></script>
// Renders a collapsed bar synchronously; makes ZERO network requests at boot
// unless there is a persisted active job AND a stored session to re-attach with.

import { consumeHandoff, consumeInviteToken, getPendingInvite, getToken, hasPendingHandoff, hasStoredSession, initAuth, redeemHandoff } from './auth'
import { screenStream } from './api'
import { mountBar } from './bar'
import { CONFIG, initConfig, resolveTheme, shouldMountHere } from './config'
import { el, icon, on, show } from './dom'
import { injectFonts } from './fonts'
import { isGuestDemo, loadGuestDemo } from './guest-demo'
import { bootRehydrate, discoverJobs, start } from './jobstore'
import { getState, patchUi, subscribe } from './state'
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

/** Main-bundle-only live browser viewer. The scripted demo mounts bar.ts
 * directly, so it never opens a network stream or exposes these controls. */
function mountLiveBrowser(shadow: ShadowRoot): { close: () => void } {
  const zone = shadow.querySelector<HTMLElement>('.ak-zone')
  const transcript = shadow.querySelector<HTMLElement>('.ak-overlay')
  const mini = shadow.querySelector<HTMLElement>('.ak-mini')
  const pill = shadow.querySelector<HTMLElement>('.ak-pill')
  if (!zone || !transcript || !mini || !pill) return { close: () => {} }

  const indicator = (cls: string): HTMLButtonElement => {
    const button = el('button', `ak-browser-indicator ${cls}`, (node) => {
      node.type = 'button'
      node.setAttribute('aria-label', 'View live browser')
    })
    button.append(
      el('span', 'ak-browser-dot', (node) => node.setAttribute('aria-hidden', 'true')),
      el('span', 'ak-browser-label', (node) => (node.textContent = 'browser')),
    )
    return button
  }
  const cornerIndicator = indicator('ak-browser-corner')
  const headerIndicator = indicator('ak-browser-header')
  zone.appendChild(cornerIndicator)
  transcript.appendChild(headerIndicator)

  const lightbox = el('div', 'ak-screen-lightbox', (node) => {
    node.setAttribute('role', 'dialog')
    node.setAttribute('aria-modal', 'true')
    node.setAttribute('aria-label', 'Live browser view')
  })
  const closeButton = el('button', 'ak-screen-close', (node) => {
    node.type = 'button'
    node.setAttribute('aria-label', 'Close live browser')
    node.appendChild(icon('x', 18))
  })
  const card = el('div', 'ak-screen-card')
  const image = el('img', 'ak-screen-image', (node) => {
    node.alt = 'Live browser view'
    node.draggable = false
  })
  const waiting = el('div', 'ak-screen-wait', (node) => {
    node.textContent = 'waiting for a browser…'
    node.setAttribute('aria-live', 'polite')
  })
  const metadata = el('div', 'ak-screen-meta')
  card.append(image, waiting, metadata)
  lightbox.append(closeButton, card)
  shadow.appendChild(lightbox)
  show(lightbox, false)
  show(image, false)
  show(metadata, false)

  let stream: AbortController | null = null
  let opener: HTMLElement | null = null
  const showWaiting = () => {
    image.removeAttribute('src')
    show(image, false)
    show(waiting, true)
    metadata.textContent = ''
    show(metadata, false)
  }
  const close = () => {
    stream?.abort()
    stream = null
    image.removeAttribute('src')
    show(lightbox, false)
    if (opener?.isConnected) opener.focus()
    opener = null
  }
  const open = () => {
    stream?.abort()
    opener = shadow.activeElement as HTMLElement | null
    const controller = new AbortController()
    stream = controller
    showWaiting()
    show(lightbox, true)
    closeButton.focus()
    void screenStream(
      CONFIG.site,
      (name, data) => {
        if (stream !== controller || name !== 'screen') return
        const jpeg = typeof data.jpeg === 'string' ? data.jpeg : ''
        if (!jpeg) {
          showWaiting()
          return
        }
        const w = Number(data.w) || 0
        const h = Number(data.h) || 0
        if (w > 0 && h > 0) {
          image.width = w
          image.height = h
        }
        image.src = `data:image/jpeg;base64,${jpeg}`
        show(image, true)
        show(waiting, false)
        let hostname = ''
        try {
          hostname = new URL(String(data.url ?? '')).hostname
        } catch {
          /* a navigating page can briefly report an incomplete URL */
        }
        metadata.textContent = [String(data.title ?? '').trim(), hostname].filter(Boolean).join(' · ')
        show(metadata, !!metadata.textContent)
      },
      controller.signal,
    ).then(
      () => {
        if (stream === controller && !controller.signal.aborted) showWaiting()
      },
      () => {
        if (stream === controller && !controller.signal.aborted) showWaiting()
      },
    )
  }

  on(cornerIndicator, 'click', open)
  on(headerIndicator, 'click', open)
  on(closeButton, 'click', close)
  on(lightbox, 'click', (event) => {
    if (event.target === lightbox) close()
  })
  on(lightbox, 'touchend', (event) => {
    if (event.target === lightbox) close()
  })
  for (const event of ['touchmove', 'wheel']) {
    lightbox.addEventListener(event, (e) => e.preventDefault(), { passive: false })
  }
  // chat.ts owns the normal bubble-lightbox/transcript Escape stack on bubble.
  // Capture first so this lightbox peels without collapsing the transcript too.
  on(window, 'keydown', (event) => {
    if (lightbox.style.display === 'none') return
    if ((event as KeyboardEvent).key === 'Tab') {
      event.preventDefault()
      closeButton.focus()
      return
    }
    if ((event as KeyboardEvent).key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    close()
  }, true)

  const render = () => {
    const state = getState()
    const live = state.job.phase === 'streaming' && state.job.browser === true
    show(cornerIndicator, live && state.ui.mode !== 'expanded')
    show(headerIndicator, live && state.ui.mode === 'expanded')
    mini.classList.toggle('browser-live', live)
    pill.classList.toggle('browser-live', live)
  }
  subscribe(render)
  render()
  return { close }
}

function mount(): void {
  const host = document.createElement('div')
  host.id = 'agent-keyboard-host'
  host.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:2147483000;pointer-events:none;'
  document.body.appendChild(host)
  // The top layer: above every stacking context on the page, and outside the
  // transform chat.ts puts on <html> to squeeze full-screen app shells beside
  // the docked transcript. Older engines keep the z-index.
  if (host.showPopover) {
    host.popover = 'manual'
    host.showPopover()
  }
  blockZoomGestures(host)

  const shadow = host.attachShadow({ mode: 'open' })
  injectFonts() // Google Fonts <link> must be in document.head (won't load from shadow DOM)
  const style = document.createElement('style')
  style.textContent = STYLES
  shadow.appendChild(style)
  const { light, accent } = resolveTheme()
  host.classList.toggle('ak-light', light)
  host.classList.toggle('ak-rainbow', CONFIG.accent === 'rainbow')
  if (accent) host.style.setProperty('--ak-accent', accent)
  // rainbow: make --ak-accent animatable so icons and rings cycle too (styles.ts).
  // @property is ignored inside a shadow root, so register it here; throws if already registered.
  if (CONFIG.accent === 'rainbow') {
    try { CSS.registerProperty({ name: '--ak-accent', syntax: '<color>', inherits: true, initialValue: '#3d93ff' }) } catch {}
  }

  initViewport(host)
  initAuth() // synchronous: sets auth slice from localStorage, no network
  const signedIn = hasStoredSession() || hasPendingHandoff() // before redeemHandoff() clears it
  if (isGuestDemo()) void loadGuestDemo()
  mountBar(shadow)
  const liveBrowser = mountLiveBrowser(shadow)
  // If we arrived from an invite/recovery link, open the transcript — its footer
  // holds the set-a-password form. Otherwise rest as the corner rectangle.
  if (getPendingInvite()) patchUi({ mode: 'expanded' })
  bootRehydrate() // re-attach only if active-job key + stored session exist
  // Arrived from the live bar into a sandbox: sign in, open, and attach to its job.
  void redeemHandoff().then((ok) => {
    if (!ok) return
    patchUi({ mode: 'expanded' })
    void discoverJobs()
  })
  if (exportReturn) void approveExport(exportReturn)

  // Page-controlled visibility. hide() collapses the transcript FIRST: when
  // expanded, chat.ts holds a body scroll lock (position:fixed), and hiding
  // the host without releasing it freezes the page under an invisible widget.
  // show() always surfaces the resting corner rectangle, never the transcript.
  const api = {
    visible: (): boolean => host.style.display !== 'none',
    show: (): void => {
      if (getState().ui.mode === 'expanded') patchUi({ mode: 'mini' })
      host.style.display = ''
    },
    hide: (): void => {
      liveBrowser.close()
      if (getState().ui.mode === 'expanded') patchUi({ mode: 'mini' })
      host.style.display = 'none'
    },
    toggle: (): boolean => {
      if (api.visible()) api.hide()
      else api.show()
      return api.visible()
    },
    // A page's own button hands the bar a prompt, sent as the signed-in
    // person from this page. false = nobody is signed in: the transcript
    // opens on its sign-in form instead.
    send: (text: string): boolean => {
      if (getState().auth !== 'authed') {
        api.show()
        patchUi({ mode: 'expanded' })
        return false
      }
      start({ text, page: location.pathname })
      return true
    },
  }
  window.__agentKeyboard = api
  // …and follows the job: `agentkeyboard:job` on window whenever it changes,
  // with the same status line the pill shows.
  let told = ''
  subscribe(() => {
    const job = getState().job
    const line = job.phase === 'streaming' ? job.line : ''
    const working = job.phase === 'sending' || (job.phase === 'streaming' && !job.idle)
    if (told === (told = job.phase + working + line)) return
    dispatchEvent(new CustomEvent('agentkeyboard:job', { detail: { working, phase: job.phase, line } }))
  })

  // data-summon: invisible until summoned — except mid-invite, where hiding
  // would bury the set-a-password form the link just opened. With
  // data-summon="signed-out", signed-in owners (or a handoff mid-sign-in) see it.
  if (CONFIG.summon && !getPendingInvite() && !(CONFIG.summonSignedOut && signedIn)) host.style.display = 'none'

  // ` / ~ summons and dismisses the whole widget. It's a typable character —
  // never hijack it while any field is focused, in the widget or on the host
  // page. Together with Escape's peeling (chat.ts: menu → lightbox →
  // transcript → corner) these are the widget's only keyboard shortcuts.
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Backquote' || e.metaKey || e.ctrlKey || e.altKey) return
    const sa = shadow.activeElement as HTMLElement | null
    if (sa && (sa.tagName === 'INPUT' || sa.tagName === 'TEXTAREA')) return
    const da = document.activeElement as HTMLElement | null
    if (da && (da.tagName === 'INPUT' || da.tagName === 'TEXTAREA' || da.isContentEditable)) return
    e.preventDefault()
    api.toggle()
  })

  // No tilde on phones: in summon mode, three quick taps anywhere
  // non-interactive toggle the widget instead.
  if (CONFIG.summon) {
    let taps = 0
    let lastTap = 0
    document.addEventListener(
      'touchend',
      (e) => {
        const t = e.target as HTMLElement | null
        if (t && (t.closest('button, a, input, textarea, select, label') || t.id === 'agent-keyboard-host')) {
          taps = 0
          return
        }
        const now = Date.now()
        taps = now - lastTap < 400 ? taps + 1 : 1
        lastTap = now
        if (taps >= 3) {
          taps = 0
          api.toggle()
        }
      },
      { passive: true },
    )
  }
}

// Moving this site to another instance (spec 19): its server's consent link lands here as
// #ak_export=<return URL>. Signed in, approving is one tap; otherwise (or if it fails) the
// server's password page takes over.
let exportReturn = ''
/** The dry run as a card at the end of the open transcript: its opt-ins as checkboxes, then
 *  Approve or Cancel. Resolves to the ticked opt-in keys, or null on Cancel. */
function exportCard(p: { summary: string; opts: { key: string; ask: string }[] }): Promise<string[] | null> {
  const scroll = document.getElementById('agent-keyboard-host')?.shadowRoot?.querySelector('.ak-ov-scroll')
  if (!scroll) return Promise.resolve(null)
  const card = el('div', 'ak-ov-list ak-export', (n) => n.setAttribute('role', 'group'))
  card.append(el('pre', 'ak-export-dry', (n) => (n.textContent = p.summary)))
  const boxes = p.opts.map((o) => {
    const c = el('input', undefined, (n) => ((n.type = 'checkbox'), (n.value = o.key)))
    card.append(el('label', 'ak-export-opt', (n) => n.append(c, ` ${o.ask}`)))
    return c
  })
  const row = el('div', 'ak-opts')
  const approve = el('button', 'ak-opt ak-export-go', (n) => ((n.type = 'button'), (n.textContent = 'Approve the move')))
  const cancel = el('button', 'ak-opt', (n) => ((n.type = 'button'), (n.textContent = 'Cancel')))
  row.append(approve, cancel)
  card.append(row)
  scroll.append(card)
  patchUi({ mode: 'expanded' })
  card.scrollIntoView({ block: 'end' })
  approve.focus()
  return new Promise((done) => {
    approve.onclick = () => {
      for (const b of [approve, cancel, ...boxes]) b.disabled = true
      approve.textContent = 'Approving…'
      done(boxes.filter((c) => c.checked).map((c) => c.value))
    }
    cancel.onclick = () => (card.remove(), done(null))
  })
}
async function approveExport(ret: string): Promise<void> {
  const site = encodeURIComponent(CONFIG.site)
  const to = new URL(ret)
  if (to.protocol !== 'https:') return // never javascript: or the like
  const form = `${CONFIG.api}/export-consent?form=1&site=${site}&return=${encodeURIComponent(ret)}`
  const token = await getToken()
  const h = { headers: { Authorization: `Bearer ${token}` } }
  // The dry run and the opt-ins come from the server (spec 20 #7), shown in the transcript (exportCard).
  const p = token && (await fetch(`${CONFIG.api}/sites/${site}/export-preview?to=${to.host}`, h).then((r) => r.ok && r.json(), () => null))
  if (!p) return void (location.href = form)
  const keys = await exportCard(p)
  if (!keys) return
  const q = new URLSearchParams(keys.map((k) => [k, '1']))
  const r = await fetch(`${CONFIG.api}/sites/${site}/export-token?${q}`, { method: 'POST', ...h }).catch(() => null)
  const t = r && r.ok && ((await r.json()) as { token?: string }).token
  if (!t) return void (location.href = form)
  to.search = new URLSearchParams({ token: t, origin: CONFIG.api, site: CONFIG.site }).toString()
  location.href = to.href
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
  consumeHandoff() // …or a sandbox sign-in handoff
  const ex = location.hash.match(/^#ak_export=([^&]+)/) // …or a move's approval
  if (ex) {
    exportReturn = decodeURIComponent(ex[1]!)
    history.replaceState(null, '', location.pathname + location.search)
  }
  window.__agentKeyboard = true
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
})()
