// The expanded full-screen chat overlay. Header (site domain, serif italic) +
// scrollable history + footer that hosts the reparented composer. History is
// fetched on FIRST expand only; older pages load via a top IntersectionObserver.

import { api, type ConversationMessage } from './api'
import { CONFIG } from './config'
import { clear as clearNode, el, icon, on, show } from './dom'
import { getActivePrompt, getActiveThumbs, getLiveTurns, getQueued } from './jobstore'
import { renderMarkdown } from './markdown'
import { getState, patchUi, subscribe } from './state'

export interface Chat {
  footerEl: HTMLElement
}

export interface ChatDeps {
  composerEl: HTMLElement
  collapse: () => void
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${(s % 60 < 10 ? '0' : '') + (s % 60)}`
}

// Terminal transcript rendering — styled after Claude Code in the terminal:
// "> " prefixed dim user lines, "●" bullets for assistant text (U+25CF, not
// U+23FA ⏺ — that one is in the emoji set and iOS renders it as a blue emoji,
// ignoring our CSS color), green tool
// dots, no bubbles, no headers.
function lineEl(cls: string, marker: string, body: HTMLElement): HTMLElement {
  const m = el('div', 'ak-t ' + cls)
  m.appendChild(el('span', 'ak-t-mark', (n) => (n.textContent = marker)))
  body.classList.add('ak-t-body')
  m.appendChild(body)
  return m
}

// -- host body scroll lock ------------------------------------------------------
// While the chat overlay is open, the page underneath must not scroll (iOS
// chains touch scrolls to the body once the inner scroller hits an edge — or
// when the touch lands outside it entirely). position:fixed is the only
// reliable iOS lock; the scroll offset is restored on unlock.
let bodyLockTop: number | null = null
function lockBody(): void {
  if (bodyLockTop != null) return
  bodyLockTop = window.scrollY
  const s = document.body.style
  s.position = 'fixed'
  s.top = `-${bodyLockTop}px`
  s.left = '0'
  s.right = '0'
  s.width = '100%'
  s.overflow = 'hidden'
}
function unlockBody(): void {
  if (bodyLockTop == null) return
  const s = document.body.style
  s.position = ''
  s.top = ''
  s.left = ''
  s.right = ''
  s.width = ''
  s.overflow = ''
  window.scrollTo(0, bodyLockTop)
  bodyLockTop = null
}

// -- lightbox (tap a thumb → full-screen; tap or Esc closes) -------------------
let lbHost: ShadowRoot | null = null
let lbEl: HTMLElement | null = null
let lbImg: HTMLImageElement | null = null

export function isLightboxOpen(): boolean {
  return !!lbEl && lbEl.style.display !== 'none'
}

export function closeLightbox(): void {
  if (lbEl) show(lbEl, false)
}

function openLightbox(src: string): void {
  if (!lbHost) return
  if (!lbEl) {
    lbEl = el('div', 'ak-lightbox')
    lbImg = el('img')
    lbImg.alt = ''
    lbEl.appendChild(lbImg)
    on(lbEl, 'click', () => closeLightbox())
    // Tap-to-dismiss is the ONLY gesture: no pinch, no pan, no scrolling the
    // content behind it. touch-action:none covers modern engines; these cover
    // iOS Safari's proprietary gestures and any scroll/wheel fallthrough.
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend', 'touchmove', 'wheel']) {
      lbEl.addEventListener(ev, (e) => e.preventDefault(), { passive: false })
    }
    // On touch devices dismiss straight from touchend — with the gesture
    // lockdown above, iOS won't reliably synthesize the click. preventDefault
    // stops a late synthesized click from double-firing.
    lbEl.addEventListener(
      'touchend',
      (e) => {
        e.preventDefault()
        closeLightbox()
      },
      { passive: false },
    )
    lbHost.appendChild(lbEl)
  }
  lbImg!.src = src
  show(lbEl, true)
}

function thumbRow(urls: string[]): HTMLElement {
  const r = el('div', 'ak-t-thumbs')
  for (const u of urls) {
    const img = el('img')
    img.src = u
    img.alt = ''
    on(img, 'click', (e) => {
      e.stopPropagation()
      openLightbox(u)
    })
    r.appendChild(img)
  }
  return r
}

/** Dim "N photos" marker for history turns (staged photos are deleted server-side). */
function photoMarker(count: number): HTMLElement {
  const m = el('div', 'ak-t-attach')
  m.appendChild(icon('camera', 11))
  m.appendChild(el('span', undefined, (n) => (n.textContent = count === 1 ? '1 photo' : `${count} photos`)))
  return m
}

function msgEl(role: 'user' | 'assistant', text: string, extras?: { thumbs?: string[]; photos?: number }): HTMLElement {
  if (role === 'user') {
    const body = el('div')
    if (extras?.thumbs?.length) body.appendChild(thumbRow(extras.thumbs))
    else if (extras?.photos) body.appendChild(photoMarker(extras.photos))
    body.appendChild(el('div', undefined, (n) => (n.textContent = text)))
    return lineEl('user', '>', body)
  }
  return lineEl('asst', '●', el('div', undefined, (n) => (n.innerHTML = renderMarkdown(text))))
}

function dividerEl(text: string): HTMLElement {
  return el('div', 'ak-divider', (n) => (n.textContent = `· ${(text || 'session compacted').toLowerCase()} ·`))
}

function nodeForMessage(m: ConversationMessage): HTMLElement {
  if (m.role === 'system') return dividerEl(m.text)
  const tools = Array.isArray(m.tools) ? (m.tools as unknown[]).map(String).filter(Boolean) : []
  if (m.role === 'assistant' && tools.length) {
    const wrap = el('div')
    for (const t of tools) wrap.appendChild(lineEl('tool', '●', el('div', undefined, (n) => (n.textContent = t))))
    if (m.text) wrap.appendChild(msgEl('assistant', m.text))
    return wrap
  }
  return msgEl(m.role, m.text, { photos: m.photos })
}

export function mountChat(shadow: ShadowRoot, deps: ChatDeps): Chat {
  const overlay = el('div', 'ak-overlay')
  // No header — just a dim collapse control floating top-right (terminal has no chrome).
  const close = el('button', 'ak-ov-close', (n) => {
    n.type = 'button'
    n.appendChild(icon('chevron-down', 18))
    n.setAttribute('aria-label', 'Collapse')
  })

  const scroll = el('div', 'ak-ov-scroll')
  const sentinel = el('div', 'ak-ov-sentinel')
  const listEl = el('div', 'ak-ov-list')
  scroll.append(sentinel, listEl)

  const footer = el('div', 'ak-ov-foot')
  overlay.append(close, scroll, footer)

  // No zoom inside the chat, ever: touch-action CSS covers modern engines;
  // iOS Safari's proprietary gesture events need explicit preventDefault.
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    overlay.addEventListener(ev, (e) => e.preventDefault())
  }
  let lastTouchEnd = 0
  overlay.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now()
      const t = e.target as HTMLElement | null
      const interactive = !!t?.closest('button, textarea, input, a')
      if (now - lastTouchEnd < 350 && !interactive) e.preventDefault() // double-tap zoom
      lastTouchEnd = now
    },
    { passive: false },
  )
  shadow.appendChild(overlay)
  show(overlay, false)

  lbHost = shadow
  on(close, 'click', () => deps.collapse())
  // Escape steps down one size each press: lightbox → chat → bar → mini corner.
  on(window, 'keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Escape') return
    if (isLightboxOpen()) return closeLightbox() // Esc peels the lightbox first…
    const mode = getState().ui.mode
    if (mode === 'expanded') return deps.collapse() // …then the chat → bar…
    if (mode === 'mini') return // already the smallest
    // …then the bar → minimized corner, unless a host-page field owns the Escape.
    const da = document.activeElement as HTMLElement | null
    const hostField =
      da && (da.tagName === 'INPUT' || da.tagName === 'TEXTAREA' || da.isContentEditable) && !da.closest?.('#agent-keyboard-host')
    if (hostField) return
    patchUi({ mode: 'mini' })
  })

  // -- history state --
  let history: ConversationMessage[] = []
  let cursor: string | null = null
  let loaded = false
  let loading = false
  let loadingOlder = false
  let renderedKey = ''

  // live bubble nodes (kept alive between tokens so scrolling stays smooth)
  let liveUser: HTMLElement | null = null
  let liveAsst: HTMLElement | null = null
  let liveTimer: HTMLElement | null = null
  let liveBody: HTMLElement | null = null
  const queuedBox = el('div')

  const staticKey = () =>
    `${history.length}|${history[0]?.id ?? ''}|${getLiveTurns().length}`

  const rebuildStatic = () => {
    clearNode(listEl)
    liveUser = liveAsst = liveTimer = liveBody = null
    for (const m of history) listEl.appendChild(nodeForMessage(m))
    for (const t of getLiveTurns()) listEl.appendChild(msgEl(t.role, t.text, { thumbs: t.thumbs }))
    if (!history.length && !getLiveTurns().length) {
      listEl.appendChild(el('div', 'ak-empty', (n) => (n.textContent = '> Ask for a change to this site.')))
    }
  }

  const updateLive = () => {
    const job = getState().job
    if (job.phase === 'streaming') {
      const prompt = getActivePrompt()
      if (!liveUser) {
        // Prompt and thumbs are fixed for the lifetime of a job — build once.
        liveUser = msgEl('user', prompt || '', { thumbs: getActiveThumbs() })
        listEl.appendChild(liveUser)
      }
      show(liveUser, !!prompt)
      if (!liveAsst) {
        // Claude Code's working line: "✻ Doing the thing… (0:24)"
        liveAsst = el('div')
        const h = el('div', 'ak-t live')
        h.appendChild(el('span', 'ak-t-mark ak-t-star', (n) => (n.textContent = '✻')))
        liveTimer = el('div', 'ak-t-body')
        h.appendChild(liveTimer)
        liveBody = el('div')
        liveAsst.append(h, lineEl('asst', '●', liveBody))
        listEl.appendChild(liveAsst)
      }
      if (liveTimer) {
        const detail = (job.line || 'Working…').replace(/\s+/g, ' ')
        liveTimer.textContent = `${detail} (${mmss(Date.now() - job.startedAt)}${job.disconnected ? ' · reconnecting…' : ''})`
      }
      if (liveBody) liveBody.innerHTML = job.fullText ? renderMarkdown(job.fullText) : ''
      const asstLine = liveBody?.closest('.ak-t') as HTMLElement | null
      if (asstLine) show(asstLine, !!job.fullText)
    } else if (liveUser || liveAsst) {
      liveUser?.remove()
      liveAsst?.remove()
      liveUser = liveAsst = liveTimer = liveBody = null
    }
    // queued sends render dim after the live block, and always last
    const q = getQueued()
    clearNode(queuedBox)
    for (const m of q) {
      const line = msgEl('user', m.text, { thumbs: m.thumbs })
      line.classList.add('queued')
      queuedBox.appendChild(line)
    }
    if (q.length) listEl.appendChild(queuedBox) // appendChild also moves it to the end
    else queuedBox.remove()
  }

  const isPinned = () => scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 48
  const toBottom = () => {
    scroll.scrollTop = scroll.scrollHeight
  }

  const loadHistory = async () => {
    loading = true
    try {
      const r = await api.conversation(CONFIG.site, { limit: 40 })
      history = r.messages || []
      cursor = r.cursor
    } catch {
      /* leave empty */
    } finally {
      loaded = true
      loading = false
      renderedKey = ''
      render()
      toBottom()
    }
  }

  const loadOlder = async () => {
    if (!cursor || loadingOlder || !loaded) return
    loadingOlder = true
    const prevH = scroll.scrollHeight
    try {
      const r = await api.conversation(CONFIG.site, { limit: 40, before: cursor })
      history = [...(r.messages || []), ...history]
      cursor = r.cursor
    } catch {
      /* ignore */
    } finally {
      loadingOlder = false
      renderedKey = ''
      render()
      scroll.scrollTop += scroll.scrollHeight - prevH // preserve anchor
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadOlder()
    },
    { root: scroll },
  )
  io.observe(sentinel)

  // Re-opening the chat always lands at the bottom (latest messages), even if
  // the user had scrolled up before collapsing — track the collapsed→expanded
  // transition and force it.
  let wasExpanded = false
  const render = () => {
    const expanded = getState().ui.mode === 'expanded'
    show(overlay, expanded)
    if (!expanded) {
      unlockBody()
      wasExpanded = false
      return
    }
    lockBody()
    if (footer.firstChild !== deps.composerEl) footer.appendChild(deps.composerEl)
    if (!loaded && !loading) {
      void loadHistory()
      return
    }
    const justOpened = !wasExpanded
    wasExpanded = true
    const pinned = isPinned()
    const key = staticKey()
    if (key !== renderedKey) {
      rebuildStatic()
      renderedKey = key
    }
    updateLive()
    if (justOpened || pinned) toBottom()
  }

  subscribe(render)
  render()

  // The working-line timer must tick even when no tokens arrive, so drive it off
  // a 1s interval while the overlay is open and a job is streaming.
  setInterval(() => {
    const st = getState()
    if (st.ui.mode === 'expanded' && st.job.phase === 'streaming') updateLive()
  }, 1000)

  return { footerEl: footer }
}
