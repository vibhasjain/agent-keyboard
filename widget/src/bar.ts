// The floating bar: appearance = f(ui, job). Owns the orb, the pill (streaming /
// done / error / login), and the single reparentable composer node. Subscribes to
// the store and reconciles the DOM on every change.

import { login } from './auth'
import { lsKey } from './config'
import { clear as clearNode, el, icon, on, show } from './dom'
import { start } from './jobstore'
import { makePhotos, type Photos } from './photos'
import { getState, patchUi, subscribe } from './state'
import { makeTicker, type Ticker } from './ticker'
import { makeVoice, type VoiceController } from './voice'
import { trackKeyboard } from './viewport'
import { mountChat, type Chat } from './chat'

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r < 10 ? '0' : ''}${r}`
}

type View = 'stream' | 'done' | 'error' | 'login' | 'composing' | 'expanded'

function computeView(): View {
  const { ui, job } = getState()
  if (ui.mode === 'expanded') return 'expanded'
  if (job.phase === 'streaming' || job.phase === 'sending') return 'stream'
  // composing/login win over the resting done/error row so tapping it to reply works
  if (ui.mode === 'login') return 'login'
  if (ui.mode === 'composing') return 'composing'
  if (job.phase === 'done') return 'done'
  if (job.phase === 'error') return 'error'
  return 'composing' // no orb — the input bar is the resting state
}

// -- composer ------------------------------------------------------------------
interface Composer {
  el: HTMLElement
  focus: () => void
  hasContent: () => boolean
  setDisabled: (d: boolean) => void
  setNote: (text: string, isError?: boolean) => void
  reset: () => void
  teardownVoice: () => void
}

function makeComposer(): Composer {
  const root = el('div', 'ak-composer')
  const photos: Photos = makePhotos(() => syncSend())
  const note = el('div', 'ak-note')

  const row = el('div', 'ak-input-row')
  const cam = el('button', 'ak-icon-btn', (n) => {
    n.type = 'button'
    n.appendChild(icon('camera'))
    n.setAttribute('aria-label', 'Add photo')
  })
  const ta = el('textarea', 'ak-ta', (n) => {
    n.rows = 1
    n.placeholder = ''
    n.setAttribute('enterkeyhint', 'send')
    n.setAttribute('aria-label', 'Message')
  })
  const mic = el('button', 'ak-icon-btn ak-mic', (n) => {
    n.type = 'button'
    n.appendChild(icon('mic'))
    n.setAttribute('aria-label', 'Dictate')
  })
  const sendBtn = el('button', 'ak-icon-btn ak-send', (n) => {
    n.type = 'button'
    n.appendChild(icon('arrow-up'))
    n.setAttribute('aria-label', 'Send')
  })
  row.append(ta, cam, mic, sendBtn)
  root.append(photos.el, row, note)
  show(note, false)

  // -- voice / dictation --
  let baseText = ''
  let partial = ''
  const joinText = (a: string, b: string) => (a.trim() ? a.trim() + ' ' + b.trim() : b.trim())
  const voice: VoiceController = makeVoice({
    getState: () => getState().ui.voice,
    onState: (s, err) => {
      // Guard against redundant writes: teardown fires onState('idle') and an
      // unconditional patchUi here would re-emit → re-render → re-teardown → loop.
      const cur = getState().ui
      if (cur.voice !== s || cur.voiceError !== err) patchUi({ voice: s, voiceError: err })
      renderMic()
      // No "Listening…" note — the mic button's live state already says it.
      if (s === 'error' && err) setNote(err, true)
      else if (s === 'idle' || s === 'live') setNote('')
    },
    onPartial: (delta) => {
      partial = joinText(partial, delta)
      ta.value = joinText(baseText, partial)
      autogrow()
      pinToEnd() // dictation past the height cap: keep the last spoken word in view
    },
    onFinal: (transcript) => {
      baseText = joinText(baseText, transcript)
      partial = ''
      ta.value = baseText
      autogrow()
      pinToEnd()
      saveDraft()
      syncSend()
    },
  })

  const renderMic = () => {
    const s = getState().ui.voice
    mic.className = 'ak-icon-btn ak-mic' + (s === 'connecting' ? ' connecting' : s === 'live' ? ' live' : '')
    clearNode(mic)
    if (s === 'connecting') mic.appendChild(el('div', 'ak-spin'))
    else mic.appendChild(icon(s === 'live' ? 'stop' : 'mic'))
  }

  const autogrow = () => {
    ta.style.height = 'auto'
    // scrollHeight is 0 while hidden/mid-reparent — don't persist a 0px height.
    if (ta.scrollHeight > 0) ta.style.height = Math.min(ta.scrollHeight, 88) + 'px'
    else ta.style.height = ''
  }

  const pinToEnd = () => {
    ta.scrollTop = ta.scrollHeight
  }

  const saveDraft = () => {
    try {
      if (ta.value) localStorage.setItem(lsKey('draft'), ta.value)
      else localStorage.removeItem(lsKey('draft'))
    } catch {
      /* ignore */
    }
  }

  const syncSend = () => {
    const has = ta.value.trim().length > 0 || photos.hasAttachments()
    sendBtn.disabled = !has || ta.disabled
  }

  const setNote = (text: string, isError = false) => {
    note.textContent = text
    note.className = 'ak-note' + (isError ? ' err' : '')
    show(note, !!text)
  }

  const doSend = () => {
    const text = ta.value.trim()
    if (!text && !photos.hasAttachments()) return
    voice.teardown()
    const attachmentIds = photos.getAttachmentIds()
    const thumbs = photos.takeThumbUrls() // transfers ownership for transcript display
    start({ text, attachmentIds, page: location.pathname, thumbs })
    reset()
    // Stay in the expanded chat if that's where the message was sent from;
    // otherwise let the bar fall back to its streaming pill.
    if (getState().ui.mode !== 'expanded') patchUi({ mode: 'collapsed' })
  }

  const reset = () => {
    ta.value = ''
    baseText = ''
    partial = ''
    autogrow()
    photos.clear()
    setNote('')
    try {
      localStorage.removeItem(lsKey('draft'))
    } catch {
      /* ignore */
    }
    syncSend()
  }

  // load any saved draft
  try {
    ta.value = localStorage.getItem(lsKey('draft')) || ''
  } catch {
    /* ignore */
  }

  on(cam, 'click', () => photos.openPicker())
  on(mic, 'click', () => voice.toggle())
  on(sendBtn, 'click', () => doSend())
  on(ta, 'input', () => {
    // user typing re-anchors the dictation base
    baseText = ta.value
    partial = ''
    autogrow()
    saveDraft()
    syncSend()
  })
  on(ta, 'keydown', (e) => {
    const ke = e as KeyboardEvent
    if (ke.key === 'Enter' && !ke.shiftKey) {
      e.preventDefault()
      doSend()
    }
  })

  // keyboard avoidance while the composer has focus
  let detachKb: (() => void) | null = null
  on(ta, 'focus', () => {
    detachKb?.()
    detachKb = trackKeyboard()
  })
  on(ta, 'blur', () => {
    detachKb?.()
    detachKb = null
  })

  autogrow()
  syncSend()
  renderMic()

  return {
    el: root,
    focus: () => ta.focus(),
    hasContent: () => ta.value.trim().length > 0 || photos.hasAttachments(),
    setDisabled: (d) => {
      ta.disabled = d
      cam.disabled = d
      syncSend()
    },
    setNote,
    reset,
    teardownVoice: () => voice.teardown(),
  }
}

// -- bar -----------------------------------------------------------------------
export function mountBar(shadow: ShadowRoot): void {
  const zone = el('div', 'ak-zone')
  const bar = el('div', 'ak-bar')
  const stash = el('div', 'ak-stash')


  // pill + its persistent rows (kept alive so the ticker animation survives updates)
  const pill = el('div', 'ak-pill')
  const shimmer = el('div', 'ak-shimmer')
  const streamRow = el('div', 'ak-stream')
  const spin = el('div', 'ak-spin')
  const tickerBox = el('div', 'ak-ticker')
  const timer = el('div', 'ak-timer')
  const expandBtn = el('button', 'ak-expand', (n) => {
    n.type = 'button'
    n.appendChild(icon('expand', 15))
    n.setAttribute('aria-label', 'Expand chat')
  })
  streamRow.append(spin, tickerBox, timer, expandBtn)

  const statusRow = el('div', 'ak-status')
  const statusDot = el('div', 'dot')
  const statusMsg = el('div', 'msg')
  const retryBtn = el('button', 'ak-retry', (n) => (n.textContent = 'Retry'))
  // Corner chat button: talk some more from right here — straight into the
  // composer, no full modal (the row tap is what opens the full chat).
  const statusChat = el('button', 'ak-expand', (n) => {
    n.type = 'button'
    n.appendChild(icon('chat', 15))
    n.setAttribute('aria-label', 'Reply')
  })
  statusRow.append(statusDot, statusMsg, statusChat)

  // Login styled as a Claude Code prompt sequence: "> email" / "> password",
  // chromeless mono inputs, dim marks that go amber on focus, hairline between.
  const loginRow = el('form', 'ak-login')
  const emailInput = el('input', undefined, (n) => {
    n.type = 'email'
    n.placeholder = 'email'
    n.autocomplete = 'username'
    n.setAttribute('enterkeyhint', 'next')
  })
  const pwInput = el('input', undefined, (n) => {
    n.type = 'password'
    n.placeholder = 'password'
    n.autocomplete = 'current-password'
    n.setAttribute('enterkeyhint', 'go')
  })
  const goBtn = el('button', 'ak-icon-btn ak-send ak-lg-go', (n) => {
    n.type = 'submit'
    n.appendChild(icon('arrow-right', 15))
    n.setAttribute('aria-label', 'Sign in')
  })
  const lgMark = () => el('span', 'ak-lg-mark', (n) => (n.textContent = '>'))
  loginRow.append(
    el('div', 'ak-lg-row', (n) => n.append(lgMark(), emailInput)),
    el('div', 'ak-lg-rule'),
    el('div', 'ak-lg-row', (n) => n.append(lgMark(), pwInput, goBtn)),
  )

  pill.append(shimmer, streamRow, statusRow, loginRow)
  bar.append(pill)
  zone.append(bar, stash)
  shadow.appendChild(zone)

  const composer = makeComposer()
  stash.appendChild(composer.el)

  // Expand is reachable while composing too (hidden once already expanded).
  const composerExpand = el('button', 'ak-icon-btn', (n) => {
    n.type = 'button'
    n.appendChild(icon('expand', 15))
    n.setAttribute('aria-label', 'Expand chat')
  })
  // Far LEFT, before the text — at the right edge it kept getting confused
  // with the send arrow.
  composer.el.querySelector('.ak-input-row')?.prepend(composerExpand)

  const chat: Chat = mountChat(shadow, {
    composerEl: composer.el,
    collapse: () => patchUi({ mode: composer.hasContent() ? 'composing' : 'collapsed' }),
  })

  const ticker: Ticker = makeTicker(tickerBox)

  // -- auth gate --
  // The input bar is always visible; the first focus while signed out swaps it
  // for the login form instead of letting the user type into nothing.
  on(composer.el, 'focusin', () => {
    if (getState().auth !== 'authed' && getState().ui.mode !== 'login') {
      patchUi({ mode: 'login' })
      setTimeout(() => emailInput.focus(), 60)
      armLoginIdle()
    }
  })

  // -- login --
  // Enter on the email line advances to the password line (prompt-sequence feel)
  // instead of submitting a half-filled form.
  on(emailInput, 'keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault()
      pwInput.focus()
    }
  })
  on(loginRow, 'input', () => loginRow.classList.remove('error'))
  let loggingIn = false

  // An untouched login form folds back into the plain bar after a while —
  // opening it was often an accidental focus, and the fields keep their values
  // for next time either way. Any interaction restarts the clock.
  const LOGIN_IDLE_MS = 12_000
  let loginIdle: ReturnType<typeof setTimeout> | null = null
  const disarmLoginIdle = () => {
    if (loginIdle != null) {
      clearTimeout(loginIdle)
      loginIdle = null
    }
  }
  const armLoginIdle = () => {
    disarmLoginIdle()
    loginIdle = setTimeout(() => {
      loginIdle = null
      if (getState().ui.mode === 'login' && !loggingIn) patchUi({ mode: 'collapsed' })
    }, LOGIN_IDLE_MS)
  }
  for (const ev of ['input', 'keydown', 'pointerdown', 'focusin']) on(loginRow, ev, armLoginIdle)
  on(loginRow, 'submit', async (e) => {
    e.preventDefault()
    if (loggingIn) return
    loggingIn = true
    disarmLoginIdle()
    goBtn.disabled = true
    try {
      await login(emailInput.value.trim(), pwInput.value)
      pwInput.value = ''
      patchUi({ mode: 'composing' })
      setTimeout(() => composer.focus(), 60)
    } catch {
      loginRow.classList.remove('shake')
      void loginRow.offsetWidth
      loginRow.classList.add('shake', 'error')
      armLoginIdle()
    } finally {
      loggingIn = false
      goBtn.disabled = false
    }
  })

  // -- expand / collapse (chat is reachable from every state) --
  on(expandBtn, 'click', () => patchUi({ mode: 'expanded' }))
  on(composerExpand, 'click', () => patchUi({ mode: 'expanded' }))
  on(statusChat, 'click', (e) => {
    e.stopPropagation()
    patchUi({ mode: 'composing' })
    setTimeout(() => composer.focus(), 60)
  })
  // Tapping a SUCCESS row opens the full chat (read the change in context);
  // tapping an error row still drops into the composer to reply/retry.
  on(statusRow, 'click', () => {
    if (getState().ui.mode === 'expanded') return
    if (getState().job.phase === 'done') {
      patchUi({ mode: 'expanded' })
      return
    }
    patchUi({ mode: 'composing' })
    setTimeout(() => composer.focus(), 60)
  })
  on(retryBtn, 'click', (e) => e.stopPropagation())

  // -- streaming timer --
  let timerId: ReturnType<typeof setInterval> | null = null
  const stopTimer = () => {
    if (timerId != null) {
      clearInterval(timerId)
      timerId = null
    }
  }
  const runTimer = () => {
    const j = getState().job
    if (j.phase !== 'streaming') return
    timer.textContent = mmss(Date.now() - j.startedAt)
  }

  // -- composer placement (single owner, focus-preserving) --
  const placeComposer = (view: View) => {
    const target = view === 'composing' ? bar : view === 'expanded' ? chat.footerEl : stash
    if (composer.el.parentNode !== target) {
      const wasFocused = shadow.activeElement && composer.el.contains(shadow.activeElement)
      target.appendChild(composer.el)
      if (wasFocused) composer.focus()
    }
  }

  // -- blur-to-collapse for composing --
  // iOS Safari doesn't focus buttons on tap, so a tap on cam/mic/send blurs the
  // textarea with focus going nowhere — guard against collapsing mid-interaction.
  let lastComposerPointer = 0
  on(composer.el, 'pointerdown', () => (lastComposerPointer = Date.now()), true)
  on(bar, 'focusout', () => {
    if (getState().ui.mode !== 'composing') return
    setTimeout(() => {
      if (getState().ui.mode !== 'composing') return
      if (Date.now() - lastComposerPointer < 400) return
      const active = shadow.activeElement
      const inside = active && composer.el.contains(active)
      if (!inside && !composer.hasContent() && getState().ui.voice === 'idle') patchUi({ mode: 'collapsed' })
    }, 160)
  })

  let lastView: View | null = null

  const render = () => {
    const view = computeView()
    const { job } = getState()

    const pillVisible = view === 'stream' || view === 'done' || view === 'error' || view === 'login'
    show(pill, pillVisible)

    // pill state class
    pill.className = 'ak-pill'
    if (view === 'stream' && job.phase === 'streaming' && job.lineState === 'thinking') pill.classList.add('thinking')
    if (view === 'done') pill.classList.add('done')
    if (view === 'error') pill.classList.add('error')

    show(shimmer, view === 'stream')
    show(streamRow, view === 'stream')
    show(statusRow, view === 'done' || view === 'error')
    show(loginRow, view === 'login')

    // stream row content
    if (view === 'stream') {
      if (lastView !== 'stream') ticker.clear()
      if (job.phase === 'sending') {
        ticker.set('Sending…', 'dim')
        timer.textContent = ''
      } else if (job.phase === 'streaming') {
        ticker.set(job.disconnected ? 'reconnecting…' : job.line || 'Working', job.disconnected ? 'dim' : job.lineState)
        runTimer()
      }
      if (timerId == null) timerId = setInterval(runTimer, 1000)
    } else {
      stopTimer()
    }

    // status row content
    if (view === 'done' && job.phase === 'done') {
      statusMsg.textContent = job.summary
      if (retryBtn.parentNode) retryBtn.remove()
    } else if (view === 'error' && job.phase === 'error') {
      statusMsg.textContent = job.message
      if (!retryBtn.parentNode) statusRow.appendChild(retryBtn)
      retryBtn.onclick = () => job.retry?.()
    }

    // composer state — typing is allowed while a job runs (sends queue up)
    show(composerExpand, view !== 'expanded')
    placeComposer(view)
    // Tear the mic down only when actually leaving the composer surfaces (never on
    // the initial render, and never every frame — that recurses through onState).
    const wasComposer = lastView === 'composing' || lastView === 'expanded'
    const isComposer = view === 'composing' || view === 'expanded'
    if (wasComposer && !isComposer) composer.teardownVoice()

    lastView = view
  }

  const unsub = subscribe(render)
  void unsub // retained for the lifetime of the page
  render()
}
