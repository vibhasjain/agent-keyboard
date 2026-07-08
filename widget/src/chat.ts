// The expanded full-screen chat overlay. Header (site domain, serif italic) +
// scrollable history + footer that hosts the reparented composer. History is
// fetched on FIRST expand only; older pages load via a top IntersectionObserver.

import { api, type ConversationMessage } from './api'
import { getSessionEmail, logout } from './auth'
import { CONFIG, lsKey } from './config'
import { clear as clearNode, el, icon, on, show } from './dom'
import { beginRestart, clearAfterRestart, discoverJobs, endRestartAttempt, getActiveFiles, getActivePrompt, getActiveThumbs, getClearEpoch, getLiveTurns, getQueued, isBusy, reconcileLiveTurns, stop } from './jobstore'
import { renderMarkdown } from './markdown'
import { getState, patchUi, subscribe } from './state'

export interface Chat {
  footerEl: HTMLElement
  /** Drop cached history so it refetches (with the authed token) on next expand — called after login. */
  resetConversation: () => void
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

/** Dim "N photos" marker for older history turns (staged photos are deleted server-side). */
function photoMarker(count: number): HTMLElement {
  const m = el('div', 'ak-t-attach')
  m.appendChild(icon('camera', 11))
  m.appendChild(el('span', undefined, (n) => (n.textContent = count === 1 ? '1 photo' : `${count} photos`)))
  return m
}

function attachmentMarker(count: number, noun = 'attachment'): HTMLElement {
  const m = el('div', 'ak-t-attach')
  m.appendChild(icon('paperclip', 11))
  m.appendChild(el('span', undefined, (n) => (n.textContent = count === 1 ? `1 ${noun}` : `${count} ${noun}s`)))
  return m
}

function msgEl(
  role: 'user' | 'assistant',
  text: string,
  extras?: { thumbs?: string[]; files?: string[]; attachments?: number; photos?: number; images?: string[] },
): HTMLElement {
  if (role === 'user') {
    const body = el('div')
    if (extras?.thumbs?.length) body.appendChild(thumbRow(extras.thumbs))
    if (extras?.files?.length) body.appendChild(attachmentMarker(extras.files.length, 'file'))
    if (extras?.attachments) body.appendChild(attachmentMarker(extras.attachments))
    else if (extras?.photos) body.appendChild(photoMarker(extras.photos))
    body.appendChild(el('div', undefined, (n) => (n.textContent = text)))
    return lineEl('user', '>', body)
  }
  // Assistant: markdown text, plus any images the agent chose to show (same
  // thumbnail + lightbox treatment as the user's own attachments).
  if (!extras?.images?.length) {
    return lineEl('asst', '●', el('div', undefined, (n) => (n.innerHTML = renderMarkdown(text))))
  }
  const body = el('div')
  if (text) body.appendChild(el('div', undefined, (n) => (n.innerHTML = renderMarkdown(text))))
  body.appendChild(thumbRow(extras.images))
  return lineEl('asst', '●', body)
}

function errorEl(text: string): HTMLElement {
  return lineEl('error', '●', el('div', undefined, (n) => (n.textContent = text)))
}

function dividerEl(text: string): HTMLElement {
  return el('div', 'ak-divider', (n) => (n.textContent = `· ${(text || 'session compacted').toLowerCase()} ·`))
}

function emptyStateEl(): HTMLElement {
  const wrap = el('div', 'ak-empty')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'ak-empty-mark')
  svg.setAttribute('viewBox', '0 0 11 8.5')
  svg.setAttribute('aria-hidden', 'true')
  const cells = [
    [2, 0], [8, 0], [1, 1], [2, 1], [3, 1], [7, 1], [8, 1], [9, 1], [2, 2], [8, 2],
    [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [2, 4], [3, 4], [5, 4], [7, 4], [8, 4],
    [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 5], [8, 5], [3, 6], [4, 6], [5, 6],
    [6, 6], [7, 6], [1, 7], [3, 7], [7, 7], [9, 7],
  ]
  for (const [x, y] of cells) {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    r.setAttribute('x', String(x))
    r.setAttribute('y', String(y))
    r.setAttribute('width', '1.02')
    r.setAttribute('height', '1.02')
    r.setAttribute('fill', 'currentColor')
    svg.appendChild(r)
  }
  wrap.appendChild(svg)
  return wrap
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
  return msgEl(m.role, m.text, { attachments: m.attachments, photos: m.photos })
}

export function mountChat(shadow: ShadowRoot, deps: ChatDeps): Chat {
  const overlay = el('div', 'ak-overlay')
  // No header — just a dim collapse control floating top-right (terminal has no chrome).
  const close = el('button', 'ak-ov-close', (n) => {
    n.type = 'button'
    n.appendChild(icon('chevron-down', 18))
    n.setAttribute('aria-label', 'Collapse')
  })

  // Settings (top-left) → a small dropdown: stop, restart, refresh, log out.
  const settings = el('button', 'ak-ov-settings', (n) => {
    n.type = 'button'
    n.appendChild(icon('settings', 18))
    n.setAttribute('aria-label', 'Settings')
  })
  const menu = el('div', 'ak-menu')
  const menuItem = (iconName: string, label: string, tip?: string) => {
    const btn = el('button', 'ak-menu-item', (n) => {
      n.type = 'button'
      if (tip) {
        n.dataset.tip = tip
        n.setAttribute('aria-description', tip)
      }
      n.appendChild(icon(iconName, 16))
      n.appendChild(el('span', undefined, (s) => (s.textContent = label)))
    })
    return btn
  }
  const identity = el('div', 'ak-menu-id') // "Signed in as X" — non-interactive header
  const stopItem = menuItem('stop', 'Stop', 'Cancel the current agent run.')
  const restartItem = menuItem('restart', 'Restart', 'Clear context, discard local checkout changes, and pull latest.')
  const refreshItem = menuItem('retry', 'Refresh', 'Reload the page and reconnect to any active run.')
  const logoutItem = menuItem('logout', 'Log out')
  menu.append(identity, stopItem, restartItem, refreshItem, logoutItem)
  show(menu, false)

  const scroll = el('div', 'ak-ov-scroll')
  const sentinel = el('div', 'ak-ov-sentinel')
  const listEl = el('div', 'ak-ov-list')
  scroll.append(sentinel, listEl)

  const footer = el('div', 'ak-ov-foot')
  overlay.append(close, settings, menu, scroll, footer)

  // -- settings menu open/close + actions --
  let menuOpen = false
  let busyAction: 'stop' | 'restart' | null = null
  const renderMenuItem = (btn: HTMLButtonElement, iconName: string, label: string, busy = false) => {
    clearNode(btn)
    btn.appendChild(busy ? el('div', 'ak-spin ak-menu-spin') : icon(iconName, 16))
    btn.appendChild(el('span', undefined, (s) => (s.textContent = label)))
  }
  const refreshBusyMenu = () => {
    renderMenuItem(stopItem as HTMLButtonElement, 'stop', busyAction === 'stop' ? 'Stopping…' : 'Stop', busyAction === 'stop')
    renderMenuItem(restartItem as HTMLButtonElement, 'restart', busyAction === 'restart' ? 'Restarting…' : 'Restart', busyAction === 'restart')
    ;(stopItem as HTMLButtonElement).disabled = busyAction !== null || !isBusy()
    ;(restartItem as HTMLButtonElement).disabled = busyAction !== null
    ;(refreshItem as HTMLButtonElement).disabled = busyAction !== null
    ;(logoutItem as HTMLButtonElement).disabled = busyAction !== null
  }
  const setMenu = (open: boolean) => {
    if (busyAction && !open) return
    menuOpen = open
    show(menu, open)
    settings.classList.toggle('on', open)
    if (open) {
      const email = getSessionEmail() // refresh on open so it's current
      identity.textContent = email ?? ''
      show(identity, !!email)
      refreshBusyMenu()
    }
  }
  on(settings, 'click', (e) => {
    e.stopPropagation()
    if (busyAction) return
    setMenu(!menuOpen)
  })
  // A click anywhere else in the overlay closes the menu.
  on(overlay, 'click', (e) => {
    const t = e.target as Node
    if (!busyAction && menuOpen && !menu.contains(t) && !settings.contains(t)) setMenu(false)
  })
  on(stopItem, 'click', async () => {
    if (busyAction || !isBusy()) return
    busyAction = 'stop'
    refreshBusyMenu()
    try {
      await stop()
    } finally {
      busyAction = null
      refreshBusyMenu()
      setMenu(false)
    }
  })
  on(restartItem, 'click', async () => {
    if (busyAction) return
    busyAction = 'restart'
    refreshBusyMenu()
    let restarted = false
    beginRestart()
    try {
      await api.restartSite(CONFIG.site)
      clearAfterRestart()
      history = []
      cursor = null
      loaded = false
      loading = false
      lastLoadTurnCount = -1
      renderedKey = ''
      restarted = true
    } catch {
      /* label updated after the busy state clears */
    } finally {
      busyAction = null
      if (!restarted) endRestartAttempt()
      refreshBusyMenu()
    }
    if (restarted) {
      setMenu(false)
      render()
    } else {
      renderMenuItem(restartItem as HTMLButtonElement, 'restart', 'Restart failed')
      setTimeout(() => {
        if (busyAction === null) refreshBusyMenu()
      }, 1600)
    }
  })
  on(refreshItem, 'click', () => {
    if (busyAction) return
    // Land back in the expanded chat after the reload (one-shot flag read at boot).
    try {
      localStorage.setItem(lsKey('reopen-expanded'), '1')
    } catch {
      /* storage blocked */
    }
    location.reload()
  })
  on(logoutItem, 'click', () => {
    if (busyAction) return
    setMenu(false)
    deps.collapse() // minimize to the bottom bar
    logout() // wipe the session immediately — logged out even if a job is mid-think
    patchUi({ signingOut: 'Logging out…' }) // spinner pill, overrides the thinking view
    setTimeout(() => patchUi({ signingOut: 'Logged out' }), 750)
    setTimeout(() => location.reload(), 1200) // reload to a fresh, guaranteed logged-out state
  })

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
    if (menuOpen) return setMenu(false) // Esc closes the settings menu first…
    if (isLightboxOpen()) return closeLightbox() // …then peels the lightbox…
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
  // liveTurns count at the last history fetch — when it differs on re-expand, a
  // turn completed since, so the tail is refetched and absorbed into canonical,
  // correctly-ordered history (idle re-opens stay fetch-free).
  let lastLoadTurnCount = -1

  // live bubble nodes (kept alive between tokens so scrolling stays smooth)
  let liveUser: HTMLElement | null = null
  let liveAsst: HTMLElement | null = null
  let liveTimer: HTMLElement | null = null
  let liveBody: HTMLElement | null = null
  const queuedBox = el('div')

  const staticKey = () =>
    `${history.length}|${history[0]?.id ?? ''}|${history[history.length - 1]?.id ?? ''}|${getLiveTurns().length}`

  const rebuildStatic = () => {
    clearNode(listEl)
    liveUser = liveAsst = liveTimer = liveBody = null
    for (const m of history) listEl.appendChild(nodeForMessage(m))
    for (const t of getLiveTurns()) {
      listEl.appendChild(
        t.role === 'error' ? errorEl(t.text) : msgEl(t.role, t.text, { thumbs: t.thumbs, files: t.files, images: t.images }),
      )
    }
    if (!history.length && !getLiveTurns().length) {
      listEl.appendChild(emptyStateEl())
    }
  }

  const updateLive = () => {
    const job = getState().job
    if (job.phase === 'streaming' || job.phase === 'sending') {
      const prompt = getActivePrompt()
      // The server persists the user turn as the job starts, so after a mid-turn
      // history fetch (a refresh / re-attach) the same prompt is already in
      // `history`. Don't also render the live bubble, or the prompt shows twice.
      const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
      const lastUser = [...history].reverse().find((m) => m.role === 'user')
      const activeFiles = getActiveFiles()
      const activeThumbs = getActiveThumbs()
      const activeAttachmentOnly = !prompt && (!!activeThumbs?.length || !!activeFiles?.length)
      const dupOfHistory =
        !!lastUser &&
        ((!!prompt && norm(lastUser.text) === norm(prompt)) ||
          (activeAttachmentOnly && !norm(lastUser.text) && (lastUser.attachments ?? lastUser.photos ?? 0) > 0))
      if (!liveUser && !dupOfHistory) {
        // Prompt and attachment previews are fixed for the lifetime of a job — build once.
        liveUser = msgEl('user', prompt || '', { thumbs: activeThumbs, files: activeFiles })
        listEl.appendChild(liveUser)
      }
      if (liveUser) show(liveUser, (!!prompt || activeAttachmentOnly) && !dupOfHistory)
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
      const streaming = job.phase === 'streaming' ? job : null
      if (liveTimer) {
        const detail = ((streaming ? streaming.line : '') || (streaming ? 'Working…' : 'Sending…')).replace(/\s+/g, ' ')
        liveTimer.textContent = `${detail} (${mmss(Date.now() - job.startedAt)}${streaming?.disconnected ? ' · reconnecting…' : ''})`
      }
      const fullText = streaming?.fullText ?? ''
      if (liveBody) liveBody.innerHTML = fullText ? renderMarkdown(fullText) : ''
      const asstLine = liveBody?.closest('.ak-t') as HTMLElement | null
      if (asstLine) show(asstLine, !!fullText)
    } else if (liveUser || liveAsst) {
      liveUser?.remove()
      liveAsst?.remove()
      liveUser = liveAsst = liveTimer = liveBody = null
    }
    // queued sends render dim after the live block, and always last
    const q = getQueued()
    clearNode(queuedBox)
    for (const m of q) {
      const line = msgEl('user', m.text, { thumbs: m.thumbs, files: m.files })
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

  // Ghost skeleton while history fetches — reuses the streaming pill's .ak-shimmer
  // sweep (reduced-motion aware). Shown the moment a load kicks off, replaced by
  // rebuildStatic() when the fetch resolves.
  const renderSkeleton = () => {
    clearNode(listEl)
    liveUser = liveAsst = liveTimer = liveBody = null
    for (const w of ['58%', '82%', '40%', '70%']) {
      const row = el('div', 'ak-skel-row', (n) => (n.style.width = w))
      row.appendChild(el('div', 'ak-shimmer'))
      listEl.appendChild(row)
    }
  }

  const loadHistory = async () => {
    loading = true
    // Cross-device: attach to a job another device started. First open only —
    // tail refreshes after local turns don't need a jobs probe.
    if (!loaded) void discoverJobs()
    try {
      const r = await api.conversation(CONFIG.site, { limit: 40 })
      history = r.messages || []
      cursor = r.cursor
      reconcileLiveTurns(history) // a turn in both history and liveTurns renders once
    } catch {
      /* leave empty */
    } finally {
      loaded = true
      loading = false
      lastLoadTurnCount = getLiveTurns().length
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
  let seenClearEpoch = getClearEpoch()
  const render = () => {
    // A "clear context" wiped the session — drop cached history and refetch the
    // now-empty conversation (liveTurns were already cleared in the store).
    if (getClearEpoch() !== seenClearEpoch) {
      seenClearEpoch = getClearEpoch()
      history = []
      cursor = null
      loaded = false
      renderedKey = ''
    }
    const expanded = getState().ui.mode === 'expanded'
    show(overlay, expanded)
    if (!expanded) {
      unlockBody()
      if (menuOpen) setMenu(false)
      wasExpanded = false
      return
    }
    lockBody()
    if (footer.firstChild !== deps.composerEl) footer.appendChild(deps.composerEl)
    if (!loaded && !loading) {
      void loadHistory()
      if (!getLiveTurns().length) {
        renderSkeleton() // paint the ghost state while the fetch is in flight
        return
      }
    }
    const justOpened = !wasExpanded
    wasExpanded = true
    // Turns completed while collapsed must render immediately; refresh the tail
    // in the background so history can absorb/reorder them when the fetch returns.
    if (justOpened && !loading && getLiveTurns().length !== lastLoadTurnCount) {
      void loadHistory()
    }
    const pinned = isPinned()
    const key = staticKey()
    if (key !== renderedKey) {
      rebuildStatic()
      renderedKey = key
    }
    updateLive()
    if (justOpened || pinned) toBottom()
  }

  // After login, drop any stale (anon/empty) history so it refetches with the
  // authed token — no manual page refresh. If expanded, render() reloads now
  // (with the skeleton); otherwise the next expand picks it up.
  const resetConversation = () => {
    history = []
    cursor = null
    loaded = false
    loading = false
    lastLoadTurnCount = -1
    renderedKey = ''
    render()
  }

  subscribe(render)
  render()

  // The working-line timer must tick even when no tokens arrive, so drive it off
  // a 1s interval while the overlay is open and a job is streaming.
  setInterval(() => {
    const st = getState()
    if (st.ui.mode === 'expanded' && (st.job.phase === 'streaming' || st.job.phase === 'sending')) updateLive()
  }, 1000)

  return { footerEl: footer, resetConversation }
}
