// The expanded full-screen chat overlay. Header (site domain, serif italic) +
// scrollable history + footer that hosts the reparented composer. History is
// fetched on FIRST expand only; older pages load via a top IntersectionObserver.

import { api, type ConversationMessage } from './api'
import { getSessionEmail, logout } from './auth'
import { CONFIG, lsKey } from './config'
import { clear as clearNode, el, icon, on, show } from './dom'
import { chooseGuestDemo, getGuestDemoMessages, getGuestDemoRevision, isGuestDemo, resetGuestDemo, subscribeGuestDemo } from './guest-demo'
import { beginRestart, clearAfterRestart, discoverJobs, endRestartAttempt, getActiveFiles, getActivePrompt, getActiveThumbs, getClearEpoch, getLiveTurns, getPendingFollowups, getQueued, getSendEpoch, isBusy, reconcileLiveTurns, start, stop } from './jobstore'
import { renderMarkdown } from './markdown'
import { getState, patchUi, subscribe, type Subagent, type TodoItem } from './state'

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

// One stable color per sender so teammates sharing a site can tell turns apart:
// djb2 over the email → hue, fixed S/L so every hue reads on the dark ground.
export function senderColor(email: string): string {
  let h = 5381
  for (let i = 0; i < email.length; i++) h = (h * 33 + email.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 55% 72%)`
}

// Turns that originate on this device (live, queued, follow-ups) are always the
// signed-in user's; cross-device re-attach carries no prompt and renders from
// history, which brings its own sender. Guest demo has no session → no tag.
const localSender = (): string | undefined => getSessionEmail() ?? undefined

function msgEl(
  role: 'user' | 'assistant',
  text: string,
  extras?: { thumbs?: string[]; files?: string[]; attachments?: number; photos?: number; images?: string[]; sender?: string },
): HTMLElement {
  if (role === 'user') {
    const body = el('div')
    if (extras?.thumbs?.length) body.appendChild(thumbRow(extras.thumbs))
    if (extras?.files?.length) body.appendChild(attachmentMarker(extras.files.length, 'file'))
    if (extras?.attachments && !extras?.thumbs?.length && !extras?.files?.length) body.appendChild(attachmentMarker(extras.attachments))
    else if (extras?.photos && !extras?.thumbs?.length) body.appendChild(photoMarker(extras.photos))
    const line = el('div')
    if (extras?.sender) {
      // Name tag precedes the text inline: "alice@x.com  make the footer amber"
      const who = el('span', 'ak-t-who', (n) => (n.textContent = extras.sender!))
      who.style.color = senderColor(extras.sender)
      line.appendChild(who)
    }
    line.appendChild(document.createTextNode(text))
    body.appendChild(line)
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

// Live task checklist (agent TodoWrite): pending ○ dim → in-progress ◐ amber →
// done ● green. Geometric-shape glyphs only (never emoji codepoints — see the
// marker note above). Rebuilt in place from the latest list; hidden when empty.
function renderTodos(host: HTMLElement, todos: TodoItem[] | undefined): void {
  clearNode(host)
  if (!todos?.length) {
    show(host, false)
    return
  }
  show(host, true)
  for (const t of todos) {
    const state = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'pending'
    const box = state === 'done' ? '●' : state === 'active' ? '◐' : '○'
    const row = el('div', 'ak-todo ' + state)
    row.appendChild(el('span', 'ak-todo-box', (n) => (n.textContent = box)))
    row.appendChild(el('span', 'ak-todo-txt', (n) => (n.textContent = t.content)))
    host.appendChild(row)
  }
}

// Running sub-agents (the `Agent` tool): a sticky "▸ <what> · running m:ss" line
// with a live elapsed timer, so you know a teammate is alive, not crashed.
function renderSubagents(host: HTMLElement, subagents: Subagent[] | undefined): void {
  clearNode(host)
  if (!subagents?.length) {
    show(host, false)
    return
  }
  show(host, true)
  for (const s of subagents) {
    const row = el('div', 'ak-agent')
    row.appendChild(el('span', 'ak-agent-mark', (n) => (n.textContent = '▸')))
    row.appendChild(el('span', 'ak-agent-desc', (n) => (n.textContent = s.desc)))
    row.appendChild(el('span', 'ak-agent-time', (n) => (n.textContent = 'running ' + mmss(Date.now() - s.startedAt))))
    host.appendChild(row)
  }
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

// The answer to an assistant turn's options is simply the next user turn — true of
// the scripted tour (which pushes the chosen label as a user message) and of a real
// chat alike, so neither needs to record what was picked. Skips system dividers and
// error rows, which sit between the two without answering anything.
// Pure, and exported for dev/answered-options.check.mjs.
export function answerFor(turns: ReadonlyArray<{ role: string; text?: string }>, index: number): string | undefined {
  if (turns[index]?.role !== 'assistant') return undefined
  for (let i = index + 1; i < turns.length; i++) {
    const role = turns[i].role
    if (role === 'system' || role === 'error') continue
    return role === 'user' ? turns[i].text ?? '' : undefined
  }
  return undefined
}

const normOpt = (s: string): string => s.replace(/\s+/g, ' ').trim()

// Once a turn has been answered its options are spent: disable every one of them
// and light the one that was taken. Without this, tapping an old option in
// scrollback silently re-sends it — days later, in a different context.
function markAnsweredOptions(node: HTMLElement, answer: string | undefined): void {
  const picked = normOpt(answer ?? '')
  if (!picked) return
  for (const button of node.querySelectorAll<HTMLButtonElement>('.ak-opt')) {
    const selected = normOpt(button.dataset.send || button.textContent || '') === picked
    button.disabled = true
    button.classList.toggle('selected', selected)
    button.setAttribute('aria-pressed', selected ? 'true' : 'false')
  }
}

function nodeForMessage(m: ConversationMessage, answer?: string): HTMLElement {
  if (m.role === 'system') return dividerEl(m.text)
  const tools = Array.isArray(m.tools) ? (m.tools as unknown[]).map(String).filter(Boolean) : []
  if (m.role === 'assistant' && tools.length) {
    const wrap = el('div')
    for (const t of tools) wrap.appendChild(lineEl('tool', '●', el('div', undefined, (n) => (n.textContent = t))))
    if (m.text) wrap.appendChild(msgEl('assistant', m.text))
    markAnsweredOptions(wrap, m.chosenOption ?? answer)
    return wrap
  }
  const node = msgEl(m.role, m.text, {
    attachments: m.attachments,
    photos: m.photos,
    thumbs: m.thumbs,
    files: m.files,
    images: m.images,
    sender: m.sender,
  })
  if (m.role === 'assistant') markAnsweredOptions(node, m.chosenOption ?? answer)
  return node
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
  const compactItem = menuItem('compact', 'Compact', 'Summarize the session to free up context.')
  const refreshItem = menuItem('retry', 'Refresh', 'Reload the page and reconnect to any active run.')
  const logoutItem = menuItem('logout', 'Log out')
  const demoResetItem = menuItem('restart', 'Start tour over')
  menu.append(identity, stopItem, restartItem, compactItem, refreshItem, logoutItem, demoResetItem)
  show(menu, false)

  const scroll = el('div', 'ak-ov-scroll')
  const sentinel = el('div', 'ak-ov-sentinel')
  const listEl = el('div', 'ak-ov-list')
  scroll.append(sentinel, listEl)

  const footer = el('div', 'ak-ov-foot')
  overlay.append(close, settings, menu, scroll, footer)

  // -- settings menu open/close + actions --
  let menuOpen = false
  let busyAction: 'stop' | 'restart' | 'compact' | null = null
  const renderMenuItem = (btn: HTMLButtonElement, iconName: string, label: string, busy = false) => {
    clearNode(btn)
    btn.appendChild(busy ? el('div', 'ak-spin ak-menu-spin') : icon(iconName, 16))
    btn.appendChild(el('span', undefined, (s) => (s.textContent = label)))
  }
  const refreshBusyMenu = () => {
    renderMenuItem(stopItem as HTMLButtonElement, 'stop', busyAction === 'stop' ? 'Stopping…' : 'Stop', busyAction === 'stop')
    renderMenuItem(restartItem as HTMLButtonElement, 'restart', busyAction === 'restart' ? 'Restarting…' : 'Restart', busyAction === 'restart')
    renderMenuItem(compactItem as HTMLButtonElement, 'compact', busyAction === 'compact' ? 'Compacting…' : 'Compact', busyAction === 'compact')
    ;(stopItem as HTMLButtonElement).disabled = busyAction !== null || !isBusy()
    ;(restartItem as HTMLButtonElement).disabled = busyAction !== null
    ;(compactItem as HTMLButtonElement).disabled = busyAction !== null
    ;(refreshItem as HTMLButtonElement).disabled = busyAction !== null
    ;(logoutItem as HTMLButtonElement).disabled = busyAction !== null
  }
  const setMenu = (open: boolean) => {
    if (busyAction && !open) return
    menuOpen = open
    show(menu, open)
    settings.classList.toggle('on', open)
    if (open) {
      const guest = isGuestDemo()
      const email = getSessionEmail() // refresh on open so it's current
      identity.textContent = guest ? 'Scripted tour · no AI used' : email ?? ''
      show(identity, guest || !!email)
      for (const item of [stopItem, restartItem, compactItem, refreshItem, logoutItem]) show(item, !guest)
      show(demoResetItem, guest) // no Login item: the form is already in the footer
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
  on(compactItem, 'click', async () => {
    if (busyAction) return
    busyAction = 'compact'
    refreshBusyMenu()
    let ok = false
    try {
      const r = await api.compact(CONFIG.site)
      ok = !!r.compacted
    } catch {
      /* fall through to the label below */
    }
    busyAction = null
    refreshBusyMenu()
    renderMenuItem(compactItem as HTMLButtonElement, 'compact', ok ? 'Compacted' : 'Nothing to compact')
    setTimeout(() => {
      if (busyAction === null) refreshBusyMenu()
    }, 1500)
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
    deps.collapse() // back to the corner, where the status line is visible
    logout() // wipe the session immediately — logged out even if a job is mid-think
    patchUi({ signingOut: 'Logging out…' }) // takes over the corner line
    setTimeout(() => patchUi({ signingOut: 'Logged out' }), 750)
    setTimeout(() => location.reload(), 1200) // reload to a fresh, guaranteed logged-out state
  })
  on(demoResetItem, 'click', () => {
    if (!isGuestDemo()) return
    resetGuestDemo()
    setMenu(false)
    setTimeout(() => toBottom(), 0)
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

  // -- open / close motion --
  // The panel slides and unblurs into place rather than cutting. display:none has
  // to wait for the close transition to actually end, so the duration is read back
  // off the stylesheet instead of being duplicated here — reduced motion sets both
  // durations to 0 and this collapses to the old instant behaviour on its own.
  let panelOpen = false
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  const setPanelOpen = (open: boolean) => {
    if (open === panelOpen) return
    panelOpen = open
    if (hideTimer != null) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    if (open) {
      show(overlay, true)
      void overlay.offsetHeight // flush, so the transition starts from the closed state
      overlay.dataset.open = 'true'
      return
    }
    overlay.dataset.open = 'false'
    const ms = parseFloat(getComputedStyle(overlay).getPropertyValue('--panel-close-dur')) || 0
    if (!ms) {
      show(overlay, false)
      return
    }
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (!panelOpen) show(overlay, false)
    }, ms)
  }

  // -- pull down to dismiss (touch) --
  // Only from the very top of the transcript (a drag mid-scroll belongs to the
  // list), never starting on a control, and only once the gesture is decisively
  // downward. The pull is resisted so it reads as weight, not a free drag.
  const DISMISS_COMMIT_PX = 82
  const DISMISS_MAX_PX = 54
  let dragX = 0
  let dragY = 0
  let dragArmed = false
  let dragging = false
  const endDrag = () => {
    dragArmed = dragging = false
    overlay.classList.remove('ak-dragging')
    overlay.style.removeProperty('--ak-dismiss-y')
    overlay.style.removeProperty('--ak-dismiss-opacity')
  }
  on(
    overlay,
    'touchstart',
    (e) => {
      const t = (e as TouchEvent).touches[0]
      const from = e.target as HTMLElement | null
      dragArmed =
        !!t &&
        scroll.scrollTop <= 1 &&
        !isLightboxOpen() &&
        !menuOpen &&
        !from?.closest('button, input, textarea, a, .ak-menu, .ak-lightbox')
      dragging = false
      if (t) {
        dragX = t.clientX
        dragY = t.clientY
      }
    },
    { passive: true },
  )
  on(
    overlay,
    'touchmove',
    (e) => {
      if (!dragArmed) return
      const t = (e as TouchEvent).touches[0]
      if (!t) return
      const dy = t.clientY - dragY
      const dx = t.clientX - dragX
      if (!dragging) {
        if (dy < -8 || Math.abs(dx) > 14) return endDrag() // scrolling or swiping sideways
        if (dy < 10 || Math.abs(dy) < Math.abs(dx) * 1.5) return
        dragging = true
        overlay.classList.add('ak-dragging')
      }
      if (dy >= DISMISS_COMMIT_PX) {
        endDrag()
        ;(shadow.activeElement as HTMLElement | null)?.blur?.()
        deps.collapse()
        return
      }
      overlay.style.setProperty('--ak-dismiss-y', `${Math.min(DISMISS_MAX_PX, dy * 0.5)}px`)
      overlay.style.setProperty('--ak-dismiss-opacity', String(Math.max(0.6, 1 - dy / 320)))
    },
    { passive: true },
  )
  on(overlay, 'touchend', endDrag, { passive: true })
  on(overlay, 'touchcancel', endDrag, { passive: true })

  lbHost = shadow
  on(close, 'click', () => deps.collapse())
  // Escape peels one layer each press: menu → lightbox → transcript → corner.
  on(window, 'keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Escape') return
    if (menuOpen) return setMenu(false) // Esc closes the settings menu first…
    if (isLightboxOpen()) return closeLightbox() // …then peels the lightbox…
    if (getState().ui.mode === 'expanded') deps.collapse() // …then the transcript itself.
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
  let seenGuestRevision = -1

  // live bubble nodes (kept alive between tokens so scrolling stays smooth)
  let liveUser: HTMLElement | null = null
  let liveAsst: HTMLElement | null = null
  let liveTimer: HTMLElement | null = null
  let liveTodos: HTMLElement | null = null
  let liveSubagents: HTMLElement | null = null
  let liveBody: HTMLElement | null = null
  const queuedBox = el('div')

  const staticKey = () =>
    `${history.length}|${history[0]?.id ?? ''}|${history[history.length - 1]?.id ?? ''}|${getLiveTurns().length}|${seenGuestRevision}`

  const rebuildStatic = () => {
    clearNode(listEl)
    liveUser = liveAsst = liveTimer = liveBody = liveTodos = liveSubagents = null
    const live = getLiveTurns()
    // One sequence for the look-ahead: a chip tapped in the last history message is
    // answered by a user turn that lands in `live`, so it has to cross the boundary.
    const turns = [...history, ...live]
    for (let i = 0; i < history.length; i++) listEl.appendChild(nodeForMessage(history[i], answerFor(turns, i)))
    for (let i = 0; i < live.length; i++) {
      const t = live[i]
      const node =
        t.role === 'error' ? errorEl(t.text) : msgEl(t.role, t.text, { thumbs: t.thumbs, files: t.files, images: t.images, sender: localSender() })
      if (t.role === 'assistant') markAnsweredOptions(node, answerFor(turns, history.length + i))
      listEl.appendChild(node)
    }
    if (!history.length && !live.length) {
      listEl.appendChild(emptyStateEl())
    }
  }

  const updateLive = () => {
    const job = getState().job
    // Idle streaming (between turns) renders as resting — drop the live working
    // block; completed turns already live in the static transcript.
    if ((job.phase === 'streaming' && !job.idle) || job.phase === 'sending') {
      const guest = isGuestDemo()
      const prompt = guest ? null : getActivePrompt()
      // The server persists the user turn as the job starts, so after a mid-turn
      // history fetch (a refresh / re-attach) the same prompt is already in
      // `history`. Don't also render the live bubble, or the prompt shows twice.
      const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
      const lastUser = [...history].reverse().find((m) => m.role === 'user')
      const activeFiles = guest ? undefined : getActiveFiles()
      const activeThumbs = guest ? undefined : getActiveThumbs()
      const activeAttachmentOnly = !prompt && (!!activeThumbs?.length || !!activeFiles?.length)
      const dupOfHistory =
        !!lastUser &&
        ((!!prompt && norm(lastUser.text) === norm(prompt)) ||
          (activeAttachmentOnly && !norm(lastUser.text) && (lastUser.attachments ?? lastUser.photos ?? 0) > 0))
      if (!guest && !liveUser && !dupOfHistory) {
        // Prompt and attachment previews are fixed for the lifetime of a job — build once.
        liveUser = msgEl('user', prompt || '', { thumbs: activeThumbs, files: activeFiles, sender: localSender() })
        listEl.appendChild(liveUser)
      }
      if (liveUser) show(liveUser, !guest && (!!prompt || activeAttachmentOnly) && !dupOfHistory)
      if (!liveAsst) {
        // Claude Code's working line: "✻ Doing the thing… (0:24)"
        liveAsst = el('div')
        const h = el('div', 'ak-t live')
        h.appendChild(el('span', 'ak-t-mark ak-t-star', (n) => (n.textContent = '✻')))
        liveTimer = el('div', 'ak-t-body')
        h.appendChild(liveTimer)
        liveSubagents = el('div', 'ak-agents')
        liveTodos = el('div', 'ak-todos')
        liveBody = el('div')
        liveAsst.append(h, liveSubagents, liveTodos, lineEl('asst', '●', liveBody))
        listEl.appendChild(liveAsst)
      }
      const streaming = job.phase === 'streaming' ? job : null
      if (liveSubagents) renderSubagents(liveSubagents, streaming?.subagents)
      if (liveTodos) renderTodos(liveTodos, streaming?.todos)
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
      liveUser = liveAsst = liveTimer = liveBody = liveTodos = liveSubagents = null
    }
    // queued sends + pending session follow-ups render dim after the live block
    const q = getQueued()
    const followups = getPendingFollowups()
    clearNode(queuedBox)
    for (const text of followups) {
      const line = msgEl('user', text, { sender: localSender() })
      line.classList.add('queued')
      queuedBox.appendChild(line)
    }
    for (const m of q) {
      const line = msgEl('user', m.text, { thumbs: m.thumbs, files: m.files, sender: localSender() })
      line.classList.add('queued')
      queuedBox.appendChild(line)
    }
    if (q.length || followups.length) listEl.appendChild(queuedBox) // appendChild moves it to the end
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
    liveUser = liveAsst = liveTimer = liveBody = liveTodos = liveSubagents = null
    for (const w of ['58%', '82%', '40%', '70%']) {
      const row = el('div', 'ak-skel-row', (n) => (n.style.width = w))
      row.appendChild(el('div', 'ak-shimmer'))
      listEl.appendChild(row)
    }
  }

  const loadHistory = async () => {
    if (isGuestDemo()) {
      history = [...getGuestDemoMessages()]
      cursor = null
      loaded = true
      loading = false
      seenGuestRevision = getGuestDemoRevision()
      renderedKey = ''
      render()
      toBottom()
      return
    }
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
    if (isGuestDemo() || !cursor || loadingOlder || !loaded) return
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

  // Tappable option buttons from a ```options block in a reply (see markdown.ts).
  // One delegated listener covers live, history, and every re-render. A tap sends
  // the option's text as the next message — start() queues it behind a running job.
  // Answered options are rebuilt disabled by rebuildStatic() and cannot re-send;
  // the guard here covers the window between the tap and that rebuild.
  on(listEl, 'click', (e) => {
    const btn = (e.target as HTMLElement)?.closest?.('.ak-opt') as HTMLButtonElement | null
    if (!btn || btn.disabled) return
    const text = (btn.dataset.send || btn.textContent || '').trim()
    if (!text) return
    if (isGuestDemo()) chooseGuestDemo(text)
    else start({ text, page: location.pathname })
  })

  // Re-opening the chat always lands at the bottom (latest messages), even if
  // the user had scrolled up before collapsing — track the collapsed→expanded
  // transition and force it.
  let wasExpanded = false
  let seenClearEpoch = getClearEpoch()
  let seenSendEpoch = getSendEpoch()
  const render = () => {
    if (isGuestDemo() && getGuestDemoRevision() !== seenGuestRevision) {
      history = [...getGuestDemoMessages()]
      cursor = null
      loaded = true
      loading = false
      seenGuestRevision = getGuestDemoRevision()
      renderedKey = ''
    }
    // A "clear context" wiped the session — drop cached history and refetch the
    // now-empty conversation (liveTurns were already cleared in the store).
    if (getClearEpoch() !== seenClearEpoch) {
      seenClearEpoch = getClearEpoch()
      history = []
      cursor = null
      loaded = false
      renderedKey = ''
    }
    // A signed-out visitor belongs here now: the tour (or an empty transcript)
    // reads above, and bar.ts keeps the login form in the footer the whole time.
    const expanded = getState().ui.mode === 'expanded'
    setPanelOpen(expanded)
    if (!expanded) {
      unlockBody()
      if (menuOpen) setMenu(false)
      wasExpanded = false
      return
    }
    lockBody()
    // The footer's occupant is bar.ts's call (placeFooter): composer when signed
    // in, the login or invite form when not. Don't fight it for the slot.
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
    // Force-scroll to a just-sent message even if the user had scrolled up
    // (covers voice / externally-triggered sends that aren't a manual submit).
    const justSent = getSendEpoch() !== seenSendEpoch
    seenSendEpoch = getSendEpoch()
    if (justOpened || pinned || justSent) toBottom()
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
  subscribeGuestDemo(render)
  render()

  // The working-line timer must tick even when no tokens arrive, so drive it off
  // a 1s interval while the overlay is open and a job is streaming.
  setInterval(() => {
    const st = getState()
    if (st.ui.mode === 'expanded' && (st.job.phase === 'streaming' || st.job.phase === 'sending')) updateLive()
  }, 1000)

  return { footerEl: footer, resetConversation }
}
