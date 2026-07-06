// The floating bar: appearance = f(ui, job). Owns the orb, the pill (streaming /
// done / error / login), and the single reparentable composer node. Subscribes to
// the store and reconciles the DOM on every change.

import { getPendingInvite, login, setPasswordWithToken } from './auth'
import { lsKey } from './config'
import { clear as clearNode, el, icon, on, show } from './dom'
import { getQueued, start } from './jobstore'
import { makePhotos, type Photos } from './photos'
import { getState, patchUi, subscribe, type UiMode } from './state'
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

type View = 'mini' | 'stream' | 'done' | 'error' | 'login' | 'setpw' | 'composing' | 'expanded' | 'signout'

function computeView(): View {
  const { ui, job } = getState()
  if (ui.signingOut) return 'signout' // logging out — overrides everything (incl. a running job)
  if (ui.mode === 'setpw') return 'setpw' // invite landing wins over everything
  if (ui.mode === 'expanded') return 'expanded'
  // An explicit minimize wins, even mid-job — so swiping the bar away while it's
  // thinking actually collapses to the ⌨️ corner (the job keeps running). A
  // re-attached job on reload surfaces the pill by setting mode=collapsed in
  // bootRehydrate, not by overriding an explicit mini here.
  if (ui.mode === 'mini') return 'mini' // smallest resting state: just the corner ⌨️
  // Active dictation takes precedence over the thinking pill — you're crafting a
  // prompt, so the composer stays up (and the mic keeps recording) even while a
  // job runs. It falls back to the pill once dictation ends.
  if (ui.voice === 'live' || ui.voice === 'connecting') return 'composing'
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
  flashConfirm: (text: string) => void
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
  const taWrap = el('div', 'ak-ta-wrap')
  const ta = el('textarea', 'ak-ta', (n) => {
    n.rows = 1
    n.placeholder = ''
    n.setAttribute('enterkeyhint', 'send')
    n.setAttribute('aria-label', 'Message')
  })
  const mirror = el('div', 'ak-ta-mirror')
  const caret = el('span', 'ak-ta-caret')
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
  // Inline "transcribing…" cue: a small amber spinner that sits after the text
  // while dictation audio is being transcribed, so the gap before words appear
  // reads as "working", not "stuck".
  const vspin = el('div', 'ak-spin ak-vspin')
  taWrap.append(ta, mirror, vspin)
  row.append(taWrap, cam, mic, sendBtn)
  root.append(photos.el, row, note)
  show(note, false)
  show(vspin, false)

  // -- voice / dictation --
  let baseText = ''
  let partial = ''
  let transcribing = false
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
    onTranscribing: (active) => {
      transcribing = active
      updateTranscribingCue()
    },
    onPartial: (delta) => {
      partial = joinText(partial, delta)
      ta.value = joinText(baseText, partial)
      autogrow()
      pinToEnd() // dictation past the height cap: keep the last spoken word in view
      updateTranscribingCue()
    },
    onFinal: (transcript) => {
      baseText = joinText(baseText, transcript)
      partial = ''
      ta.value = baseText
      autogrow()
      pinToEnd()
      saveDraft()
      syncSend()
      updateTranscribingCue()
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
    updateTranscribingCue()
  }

  const pinToEnd = () => {
    ta.scrollTop = ta.scrollHeight
  }

  const updateTranscribingCue = () => {
    if (!transcribing) {
      show(vspin, false)
      return
    }
    const end = ta.selectionStart ?? ta.value.length
    const before = ta.value.slice(0, end)
    mirror.textContent = ''
    mirror.appendChild(document.createTextNode(before.endsWith('\n') ? before + '\u200b' : before || '\u200b'))
    mirror.appendChild(caret)
    const maxX = Math.max(8, ta.clientWidth - 12)
    const maxY = Math.max(8, ta.clientHeight - 9)
    const x = Math.min(Math.max(8, caret.offsetLeft + 8), maxX)
    const y = Math.min(Math.max(7, caret.offsetTop - ta.scrollTop + 13), maxY)
    vspin.style.transform = `translate(${x}px, ${y}px)`
    show(vspin, true)
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
    sendBtn.disabled = false
  }

  const setNote = (text: string, isError = false) => {
    note.textContent = text
    note.className = 'ak-note' + (isError ? ' err' : '')
    show(note, !!text)
  }

  let sending = false
  const doSend = async () => {
    if (sending) return
    if (photos.isUploading()) {
      // Don't silently drop an in-flight photo from the send payload.
      setNote('Photo still uploading…', true)
      return
    }
    sending = true
    try {
      // If dictation is live, commit + fold its transcript in FIRST — hitting send
      // without tapping the mic off must not drop what was just spoken. No-op when
      // not dictating; brief spinner while the last words transcribe.
      await voice.flush()
      const text = ta.value.trim()
      if (!text && !photos.hasAttachments()) return
      const attachmentIds = photos.getAttachmentIds()
      const thumbs = photos.takeThumbUrls() // transfers ownership for transcript display
      start({ text, attachmentIds, page: location.pathname, thumbs })
      reset()
      // No "Queued" note — the queue is already visible (dim lines + the +N badge).
      // Stay in the expanded chat if that's where the message was sent from;
      // otherwise let the bar fall back to its streaming pill.
      if (getState().ui.mode !== 'expanded') patchUi({ mode: 'collapsed' })
    } finally {
      sending = false
    }
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

  // paste an image straight into the composer (screenshots, copied pics). Text
  // pastes fall through untouched — we only swallow the event when it carries images.
  on(ta, 'paste', (e) => {
    const dt = (e as ClipboardEvent).clipboardData
    if (!dt) return
    const files: File[] = []
    for (const item of Array.from(dt.items || [])) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (!files.length) for (const f of Array.from(dt.files || [])) if (f.type.startsWith('image/')) files.push(f)
    if (!files.length) return
    e.preventDefault()
    photos.addFiles(files)
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

  // Camera + mic fire on click without the textarea focus that gates the rest of
  // the composer (focusing the textarea is what opens the login form), so they'd
  // leak while signed out. Disable both until authed — a disabled button neither
  // clicks nor focuses, and the .ak-icon-btn:disabled style dims it.
  const applyAuthLock = () => {
    const locked = getState().auth !== 'authed'
    cam.disabled = locked
    mic.disabled = locked
  }
  applyAuthLock()
  subscribe(applyAuthLock)

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
    // Flash a brief amber confirmation as the composer's placeholder, then clear it.
    flashConfirm: (text) => {
      ta.placeholder = text
      ta.classList.add('ak-confirm')
      setTimeout(() => {
        ta.classList.remove('ak-confirm')
        ta.placeholder = ''
      }, 1200)
    },
    reset,
    teardownVoice: () => voice.teardown(),
  }
}

// -- bar -----------------------------------------------------------------------
export function mountBar(shadow: ShadowRoot): void {
  const zone = el('div', 'ak-zone')
  const bar = el('div', 'ak-bar')
  const stash = el('div', 'ak-stash')

  // Smallest resting state: a round ⌨️ button parked bottom-right. Click (or the
  // tilde shortcut) opens the full bar. The ⌨️ is the brand mark (allowed exception).
  const miniBtn = el('button', 'ak-mini', (n) => {
    n.type = 'button'
    n.setAttribute('aria-label', 'Open Agent Keyboard')
    n.appendChild(el('span', 'ak-mini-glyph', (g) => (g.textContent = '⌨️')))
  })


  // pill + its persistent rows (kept alive so the ticker animation survives updates)
  const pill = el('div', 'ak-pill')
  const shimmer = el('div', 'ak-shimmer')
  const streamRow = el('div', 'ak-stream')
  const spin = el('div', 'ak-spin')
  const tickerBox = el('div', 'ak-ticker')
  const timer = el('div', 'ak-timer')
  const queueBadge = el('div', 'ak-qbadge') // "+N" queued sends
  const expandBtn = el('button', 'ak-expand', (n) => {
    n.type = 'button'
    n.appendChild(icon('expand', 15))
    n.setAttribute('aria-label', 'Expand chat')
  })
  streamRow.append(spin, tickerBox, timer, queueBadge, expandBtn)

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
  // Dismiss the login form back to the empty composer — so a signed-out user is
  // never trapped in the sign-in fields (the bar auto-focuses on open).
  const loginBack = el('button', 'ak-lg-back', (n) => {
    n.type = 'button'
    n.textContent = '← back'
    n.setAttribute('aria-label', 'Back')
  })
  const lgMark = () => el('span', 'ak-lg-mark', (n) => (n.textContent = '>'))
  loginRow.append(
    el('div', 'ak-lg-row', (n) => n.append(lgMark(), emailInput, loginBack)),
    el('div', 'ak-lg-rule'),
    el('div', 'ak-lg-row', (n) => n.append(lgMark(), pwInput, goBtn)),
  )

  // Invite / recovery landing: finish setting a password right here (the link
  // redirected to this page with a fresh token — see auth.consumeInviteToken).
  const setpwRow = el('form', 'ak-login')
  const setpwLabel = el('div', 'ak-setpw-label')
  const setpwInput = el('input', undefined, (n) => {
    n.type = 'password'
    n.placeholder = 'choose a password'
    n.autocomplete = 'new-password'
    n.minLength = 8
    n.setAttribute('enterkeyhint', 'go')
  })
  const setpwGo = el('button', 'ak-icon-btn ak-send ak-lg-go', (n) => {
    n.type = 'submit'
    n.appendChild(icon('arrow-right', 15))
    n.setAttribute('aria-label', 'Set password')
  })
  setpwRow.append(
    el('div', 'ak-lg-row', (n) => n.append(setpwLabel)),
    el('div', 'ak-lg-rule'),
    el('div', 'ak-lg-row', (n) => n.append(lgMark(), setpwInput, setpwGo)),
  )

  pill.append(shimmer, streamRow, statusRow, loginRow, setpwRow)
  bar.append(pill)
  zone.append(miniBtn, bar, stash)
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
  // for the login form instead of letting the user type into nothing. Pressing
  // "back" dismisses it — a brief window then keeps the empty composer put so the
  // dismiss doesn't immediately bounce back into login.
  let lastLoginDismiss = 0
  on(composer.el, 'focusin', () => {
    if (Date.now() - lastLoginDismiss < 600) return
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
  on(loginBack, 'click', () => {
    disarmLoginIdle()
    lastLoginDismiss = Date.now()
    ;(shadow.activeElement as HTMLElement | null)?.blur?.() // drop the keyboard, don't refocus into the gate
    patchUi({ mode: 'composing' })
  })
  on(loginRow, 'submit', async (e) => {
    e.preventDefault()
    if (loggingIn) return
    loggingIn = true
    disarmLoginIdle()
    goBtn.disabled = true
    clearNode(goBtn)
    goBtn.appendChild(el('div', 'ak-spin')) // signing-in spinner (was just a silent disable)
    try {
      await login(emailInput.value.trim(), pwInput.value)
      pwInput.value = ''
      chat.resetConversation() // drop stale/empty history so it reloads authed — no manual refresh
      patchUi({ mode: 'composing' }) // straight into the prompt box — no refresh needed
      setTimeout(() => composer.focus(), 60)
      composer.flashConfirm('Logged in ✓') // brief amber confirmation in the prompt placeholder
    } catch {
      loginRow.classList.remove('shake')
      void loginRow.offsetWidth
      loginRow.classList.add('shake', 'error')
      armLoginIdle()
    } finally {
      loggingIn = false
      goBtn.disabled = false
      clearNode(goBtn)
      goBtn.appendChild(icon('arrow-right', 15)) // restore the arrow
    }
  })

  // -- invite / recovery: set a password, then land signed-in --
  let settingPw = false
  on(setpwRow, 'input', () => setpwRow.classList.remove('error'))
  on(setpwRow, 'submit', async (e) => {
    e.preventDefault()
    if (settingPw) return
    if (setpwInput.value.length < 8) {
      setpwRow.classList.remove('shake')
      void setpwRow.offsetWidth
      setpwRow.classList.add('shake', 'error')
      setpwLabel.textContent = 'Use at least 8 characters'
      return
    }
    settingPw = true
    setpwGo.disabled = true
    try {
      await setPasswordWithToken(setpwInput.value)
      setpwInput.value = ''
      patchUi({ mode: 'composing' })
      setTimeout(() => composer.focus(), 60)
    } catch (err) {
      setpwRow.classList.remove('shake')
      void setpwRow.offsetWidth
      setpwRow.classList.add('shake', 'error')
      setpwLabel.textContent = err instanceof Error ? err.message : 'Could not set the password'
    } finally {
      settingPw = false
      setpwGo.disabled = false
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
    if (j.phase !== 'streaming' && j.phase !== 'sending') return
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

  // Touch devices pop an on-screen keyboard on focus, so we only auto-focus the
  // prompter when opening the bar on a precise-pointer (desktop) device.
  const isTouch = () => {
    try {
      return matchMedia('(pointer: coarse)').matches
    } catch {
      return false
    }
  }
  // Open the bar from the minimized corner; on desktop, drop the cursor straight
  // into the prompter so you can just start typing.
  const openBar = () => {
    patchUi({ mode: 'collapsed' })
    if (!isTouch()) setTimeout(() => composer.focus(), 60)
  }

  // -- three-state cycle (mini → bar → expanded → mini) --
  // Bound to the tilde key and reused by the mini button. Any non-mini/expanded
  // mode counts as "the bar", so composing/login/done all advance to expanded.
  const cycleState = () => {
    const m = getState().ui.mode
    if (m === 'mini') return openBar()
    const next: UiMode = m === 'expanded' ? 'mini' : 'expanded'
    patchUi({ mode: next })
  }

  // Tilde toggles the states, Quake-console style. It's a typable character, so
  // never hijack it while a field is focused — in the composer/login inputs, or
  // in any input on the host page — let it type normally there.
  on(document, 'keydown', (e) => {
    const ke = e as KeyboardEvent
    if (ke.code !== 'Backquote' || ke.metaKey || ke.ctrlKey || ke.altKey) return
    const sa = shadow.activeElement as HTMLElement | null
    if (sa && (sa.tagName === 'INPUT' || sa.tagName === 'TEXTAREA')) return
    const da = document.activeElement as HTMLElement | null
    if (da && (da.tagName === 'INPUT' || da.tagName === 'TEXTAREA' || da.isContentEditable)) return
    ke.preventDefault()
    cycleState()
  })

  on(miniBtn, 'click', openBar)

  // -- swipe the bar right to minimize (touch) --
  // A clear rightward swipe on the bar folds it back to the corner. Only from a
  // middle state (not mini/expanded), and only when the drag is decisively
  // horizontal, so it never fights vertical scrolling or a tap on a control.
  let swX = 0, swY = 0, swiping = false
  on(bar, 'touchstart', (e) => {
    const t = (e as TouchEvent).touches[0]
    const m = getState().ui.mode
    if (!t || m === 'mini' || m === 'expanded') { swiping = false; return }
    swX = t.clientX; swY = t.clientY; swiping = true
  }, { passive: true })
  on(bar, 'touchmove', (e) => {
    if (!swiping) return
    const t = (e as TouchEvent).touches[0]
    if (!t) return
    const dx = t.clientX - swX, dy = t.clientY - swY
    if (dx >= 70 && Math.abs(dx) > Math.abs(dy) * 1.8) {
      swiping = false
      const ae = shadow.activeElement as HTMLElement | null
      ae?.blur?.() // drop the keyboard as we collapse
      patchUi({ mode: 'mini' })
    }
  }, { passive: true })
  const endSwipe = () => { swiping = false }
  on(bar, 'touchend', endSwipe, { passive: true })
  on(bar, 'touchcancel', endSwipe, { passive: true })

  // -- idle auto-collapse to the corner --
  // If it's been open and untouched for a while, fold back to the smallest state.
  // Never while working (a job is in flight), dictating, or with a draft in hand.
  const IDLE_MS = 60_000
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const canIdle = () => {
    const s = getState()
    return (
      s.ui.mode !== 'mini' &&
      s.job.phase !== 'streaming' &&
      s.job.phase !== 'sending' &&
      s.ui.voice === 'idle' &&
      !composer.hasContent()
    )
  }
  const armIdle = () => {
    if (idleTimer != null) clearTimeout(idleTimer)
    idleTimer = null
    if (!canIdle()) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (canIdle()) patchUi({ mode: 'mini' })
    }, IDLE_MS)
  }
  // Any interaction inside the widget restarts the clock.
  for (const ev of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart'])
    shadow.addEventListener(ev, armIdle, { passive: true, capture: true })

  let lastView: View | null = null

  const render = () => {
    const view = computeView()
    const { job } = getState()

    // mini: hide the whole bar, show just the corner ⌨️
    show(miniBtn, view === 'mini')
    show(bar, view !== 'mini')

    const pillVisible =
      view === 'stream' || view === 'done' || view === 'error' || view === 'login' || view === 'setpw' || view === 'signout'
    show(pill, pillVisible)

    // pill state class
    pill.className = 'ak-pill'
    if (view === 'stream' && job.phase === 'streaming' && job.lineState === 'thinking') pill.classList.add('thinking')
    if (view === 'done') pill.classList.add('done')
    if (view === 'error') pill.classList.add('error')

    show(shimmer, view === 'stream')
    show(streamRow, view === 'stream' || view === 'signout') // signout reuses the spin + ticker row
    show(expandBtn, view === 'stream') // no expand affordance while signing out
    show(statusRow, view === 'done' || view === 'error')
    show(loginRow, view === 'login')
    show(setpwRow, view === 'setpw')
    if (view === 'setpw' && lastView !== 'setpw') {
      const inv = getPendingInvite()
      setpwLabel.textContent = inv?.email ? `Welcome — set a password for ${inv.email}` : 'Welcome — set a password'
      setTimeout(() => setpwInput.focus(), 60)
    }

    // signing-out: spinner + "Logging out…" / "Logged out", nothing else
    if (view === 'signout') {
      ticker.set(getState().ui.signingOut || 'Logging out…', 'dim')
      timer.textContent = ''
      show(queueBadge, false)
    }

    // stream row content
    if (view === 'stream') {
      if (lastView !== 'stream') ticker.clear()
      if (job.phase === 'sending') {
        ticker.set('Sending…', 'dim')
        runTimer() // the timer counts from the send tap, not the first frame
      } else if (job.phase === 'streaming') {
        ticker.set(job.disconnected ? 'reconnecting…' : job.line || 'Working', job.disconnected ? 'dim' : job.lineState)
        runTimer()
      }
      const q = getQueued().length
      queueBadge.textContent = q ? `+${q}` : ''
      show(queueBadge, q > 0)
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
    // Never cut the mic while it's live/connecting — minimizing the modal must not
    // cancel a recording (the composing view above keeps it up regardless).
    if (wasComposer && !isComposer && getState().ui.voice === 'idle') composer.teardownVoice()

    lastView = view
    armIdle() // re-arm (or cancel) the idle-collapse clock on every state change
  }

  const unsub = subscribe(render)
  void unsub // retained for the lifetime of the page

  // A refresh from the settings menu asked to land back in the expanded chat.
  try {
    if (localStorage.getItem(lsKey('reopen-expanded')) === '1') {
      localStorage.removeItem(lsKey('reopen-expanded'))
      patchUi({ mode: 'expanded' })
    }
  } catch {
    /* storage blocked */
  }

  render()
}
