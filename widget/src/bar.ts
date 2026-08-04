// The floating bar: appearance = f(ui, job). TWO surfaces, ever — a small status
// rectangle parked in the bottom-right corner, and the full-screen transcript you
// get by clicking it. done / error / signing-out are lines of text inside the
// rectangle; login and the invite form are footer swaps inside the transcript.
// Owns the rectangle, the streaming pill that replaces it in place, and the single
// reparentable composer / auth nodes. Reconciles the DOM on every store change.

import { getPendingInvite, login, setPasswordWithToken } from './auth'
import { lsKey } from './config'
import { clear as clearNode, el, icon, on, show } from './dom'
import { getQueued, start } from './jobstore'
import { makePhotos, type Photos } from './photos'
import { getState, patchUi, subscribe } from './state'
import * as stopPhrase from './stopphrase'
import { makeTicker, thinkingWord, type Ticker } from './ticker'
import { makeVoice, type VoiceController } from './voice'
import { trackKeyboard } from './viewport'
import { mountChat, type Chat } from './chat'

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r < 10 ? '0' : ''}${r}`
}

type View = 'mini' | 'stream' | 'expanded'

// `stream` is not a third surface: it's the same corner box as `mini`, swapped for
// the pill so the ticker, timer and +N badge get their own row. Everything else
// that used to be a view is now text inside the rectangle.
function computeView(): View {
  const { ui, job } = getState()
  if (ui.mode === 'expanded') return 'expanded'
  // An explicit minimize wins, even mid-job — the rectangle still carries the
  // streamed line, and the job keeps running. A re-attached job on reload surfaces
  // the pill by setting mode=collapsed in bootRehydrate, not by overriding mini.
  if (ui.mode === 'mini') return 'mini'
  // An idle streaming session (open between turns, awaiting a follow-up) rests as
  // the plain rectangle — no spinner/timer pill. Active work still shows the pill.
  if ((job.phase === 'streaming' && !job.idle) || job.phase === 'sending') return 'stream'
  return 'mini'
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
  const attach = el('button', 'ak-icon-btn', (n) => {
    n.type = 'button'
    n.appendChild(icon('paperclip'))
    n.setAttribute('aria-label', 'Attach file')
  })
  const taWrap = el('div', 'ak-ta-wrap')
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
  taWrap.append(ta)
  row.append(taWrap, cam, attach, mic, sendBtn)
  root.append(photos.el, row, note)
  show(note, false)

  // -- voice / dictation --
  let baseText = ''
  let partial = ''
  const joinText = (a: string, b: string) => (a.trim() ? a.trim() + ' ' + b.trim() : b.trim())
  // "…over and out" ends dictation and auto-sends, mirroring the iOS app's
  // SpeechStopPhrase. One-shot per recording — reset when a new one starts.
  let hasTriggeredStopPhrase = false
  const maybeTriggerStopPhrase = (combined: string): boolean => {
    if (hasTriggeredStopPhrase || !stopPhrase.contains(combined)) return false
    hasTriggeredStopPhrase = true
    baseText = stopPhrase.cleaned(combined)
    partial = ''
    ta.value = baseText
    autogrow()
    voice.teardown() // hard stop: we already have the text we need, no transcript wait
    void doSend()
    return true
  }
  const voice: VoiceController = makeVoice({
    getState: () => getState().ui.voice,
    onState: (s, err) => {
      // Guard against redundant writes: teardown fires onState('idle') and an
      // unconditional patchUi here would re-emit → re-render → re-teardown → loop.
      const cur = getState().ui
      if (cur.voice !== s || cur.voiceError !== err) patchUi({ voice: s, voiceError: err })
      if (s === 'connecting') hasTriggeredStopPhrase = false // new recording session
      renderMic()
      // No "Listening…" note — the mic button's live state already says it.
      if (s === 'error' && err) setNote(err, true)
      else if (s === 'idle' || s === 'live') setNote('')
    },
    onPartial: (delta) => {
      partial = joinText(partial, delta)
      const combined = joinText(baseText, partial)
      if (maybeTriggerStopPhrase(combined)) return
      ta.value = combined
      autogrow()
      pinToEnd() // dictation past the height cap: keep the last spoken word in view
    },
    onFinal: (transcript) => {
      const combined = joinText(baseText, transcript)
      if (maybeTriggerStopPhrase(combined)) return
      baseText = combined
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
    sendBtn.disabled = false
  }

  const setNote = (text: string, isError = false) => {
    note.textContent = text
    note.className = 'ak-note' + (isError ? ' err' : '')
    show(note, !!text)
  }

  const stopVoiceKeepingPrompt = () => {
    voice.teardown()
    baseText = ta.value
    partial = ''
    saveDraft()
    syncSend()
  }

  let sending = false
  const doSend = async () => {
    if (sending) return
    if (photos.isUploading()) {
      // Don't silently drop an in-flight attachment from the send payload.
      setNote('Attachment still uploading…', true)
      return
    }
    sending = true
    try {
      // If dictation is live, commit + fold its transcript in FIRST — hitting send
      // without tapping the mic off must not drop what was just spoken. No-op when
      // not dictating.
      await voice.flush()
      const text = ta.value.trim()
      if (!text && !photos.hasAttachments()) return
      const attachmentIds = photos.getAttachmentIds()
      const previews = photos.takePreviews() // transfers thumbnail ownership for transcript display
      start({ text, attachmentIds, page: location.pathname, thumbs: previews.thumbs, files: previews.files })
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

  const blurButton = (button: HTMLButtonElement) => {
    button.blur()
  }
  on(cam, 'click', () => {
    blurButton(cam)
    photos.openPicker()
  })
  on(attach, 'click', () => {
    blurButton(attach)
    photos.openFilePicker()
  })
  on(mic, 'click', () => {
    blurButton(mic)
    voice.toggle()
  })
  on(sendBtn, 'click', () => {
    blurButton(sendBtn)
    doSend()
  })
  on(root, 'keydown', (e) => {
    const ke = e as KeyboardEvent
    if (ke.key !== 'Enter' || ke.shiftKey || ke.metaKey || ke.ctrlKey || ke.altKey || ke.isComposing) return
    const target = ke.target as HTMLElement | null
    if (target === ta || !target?.closest('button')) return
    e.preventDefault()
    e.stopPropagation()
    doSend()
  }, true)

  const filesFromTransfer = (dt: DataTransfer | null): File[] => {
    if (!dt) return []
    const files: File[] = []
    for (const item of Array.from(dt.items || [])) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (!files.length) files.push(...Array.from(dt.files || []))
    return files
  }

  on(document, 'keydown', (e) => {
    const voiceState = getState().ui.voice
    if (voiceState !== 'connecting' && voiceState !== 'live') return
    const ke = e as KeyboardEvent
    if (ke.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      stopVoiceKeepingPrompt()
      return
    }
    if (ke.key !== 'Enter' || ke.shiftKey || ke.metaKey || ke.ctrlKey || ke.altKey || ke.isComposing) return
    e.preventDefault()
    e.stopPropagation()
    if (voiceState === 'connecting') stopVoiceKeepingPrompt()
    doSend()
  }, true)
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

  // Paste attachments straight into the composer. Text pastes fall through
  // untouched — we only swallow the event when it carries files.
  on(ta, 'paste', (e) => {
    const files = filesFromTransfer((e as ClipboardEvent).clipboardData)
    if (!files.length) return
    e.preventDefault()
    photos.addFiles(files)
  })
  on(root, 'dragover', (e) => {
    const files = filesFromTransfer((e as DragEvent).dataTransfer)
    if (!files.length) return
    e.preventDefault()
  })
  on(root, 'drop', (e) => {
    const files = filesFromTransfer((e as DragEvent).dataTransfer)
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
    attach.disabled = locked
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
      attach.disabled = d
      mic.disabled = d
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

  // The resting surface: a small rectangle parked bottom-right carrying one line of
  // status — "Log in" signed out, "Whatsup?" idle, the job's own summary or
  // error once it finishes. Click (or the tilde shortcut) opens the transcript. The
  // ⌨️ is the brand mark (the documented emoji exception).
  const miniBtn = el('button', 'ak-mini', (n) => {
    n.type = 'button'
    n.setAttribute('aria-label', 'Open Agent Keyboard')
  })
  const miniGlyph = el('span', 'ak-mini-glyph', (n) => {
    n.textContent = '⌨️'
    n.setAttribute('aria-hidden', 'true')
  })
  const miniCopy = el('span', 'ak-mini-copy')
  const miniArrow = icon('arrow-right', 15)
  miniArrow.classList.add('ak-mini-arrow')
  miniBtn.append(miniGlyph, miniCopy, miniArrow)

  // pill: the same corner box as the rectangle, swapped in while a job streams so
  // the ticker/timer/+N badge get a row of their own. Rows are kept alive so the
  // ticker animation survives updates. Clicking anywhere on it opens the transcript.
  const pill = el('button', 'ak-pill', (n) => {
    n.type = 'button'
    n.setAttribute('aria-label', 'Open Agent Keyboard')
  })
  const shimmer = el('div', 'ak-shimmer')
  const streamRow = el('div', 'ak-stream')
  const spin = el('div', 'ak-spin')
  const tickerBox = el('div', 'ak-ticker')
  const timer = el('div', 'ak-timer')
  const queueBadge = el('div', 'ak-qbadge') // "+N" queued sends
  streamRow.append(spin, tickerBox, timer, queueBadge)

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

  // Signed-out auth lives in the transcript footer, not in the corner box — the
  // scripted tour reads above it and the form stays put instead of being a surface
  // you have to find. The wrappers give each form the same card chrome the composer
  // has in that slot.
  const loginFooter = el('div', 'ak-auth-footer', (n) => n.appendChild(loginRow))
  const setpwFooter = el('div', 'ak-auth-footer', (n) => n.appendChild(setpwRow))

  pill.append(shimmer, streamRow)
  bar.append(pill)
  zone.append(miniBtn, bar, stash)
  shadow.appendChild(zone)

  const composer = makeComposer()
  stash.append(composer.el, loginFooter, setpwFooter)

  // Back to the corner. A hidden-but-focused composer keeps :host(.ak-kbd) on after
  // the transcript closes, which strands the rectangle mid-screen — release focus
  // first. `collapsed` (rather than `mini`) lets a running job keep the pill.
  const collapseToCorner = () => {
    ;(shadow.activeElement as HTMLElement | null)?.blur?.()
    const { phase } = getState().job
    patchUi({ mode: phase === 'streaming' || phase === 'sending' ? 'collapsed' : 'mini' })
  }

  const chat: Chat = mountChat(shadow, { composerEl: composer.el, collapse: collapseToCorner })

  const ticker: Ticker = makeTicker(tickerBox)

  // -- login --
  // Enter on the email line advances to the password line (prompt-sequence feel)
  // instead of submitting a half-filled form.
  on(emailInput, 'keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault()
      pwInput.focus()
    }
  })
  on(loginRow, 'input', () => {
    loginRow.classList.remove('error')
    pwInput.placeholder = 'password' // clear a failure message left in its place
  })
  let loggingIn = false

  // Keyboard avoidance for the login fields — same trackKeyboard() the composer
  // uses (viewport.ts lifts the whole .ak-zone via --ak-kb), delegated on the
  // form so tabbing between email/password doesn't detach/reattach.
  let detachLoginKb: (() => void) | null = null
  on(loginRow, 'focusin', () => {
    if (!detachLoginKb) detachLoginKb = trackKeyboard()
  })
  on(loginRow, 'focusout', () => {
    setTimeout(() => {
      if (!loginRow.contains(shadow.activeElement)) {
        detachLoginKb?.()
        detachLoginKb = null
      }
    }, 0)
  })

  on(loginRow, 'submit', async (e) => {
    e.preventDefault()
    if (loggingIn) return
    loggingIn = true
    goBtn.disabled = true
    clearNode(goBtn)
    goBtn.appendChild(el('div', 'ak-spin')) // signing-in spinner (was just a silent disable)
    try {
      await login(emailInput.value.trim(), pwInput.value)
      pwInput.value = ''
      chat.resetConversation() // drop stale/empty history so it reloads authed — no manual refresh
      // Still expanded: render() swaps the footer from this form to the composer.
      composer.flashConfirm('Logged in ✓') // brief amber confirmation in the prompt placeholder
    } catch (err) {
      // Say what actually went wrong. "Invalid login credentials" and "Email not
      // confirmed" are different problems and a bare shake told you neither — the
      // password is cleared anyway on a failed attempt, so its placeholder is free.
      pwInput.value = ''
      pwInput.placeholder = err instanceof Error ? err.message : 'could not sign in'
      loginRow.classList.remove('shake')
      void loginRow.offsetWidth
      loginRow.classList.add('shake', 'error')
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
      // Authed now — render() swaps the footer from this form to the composer.
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

  // -- expand / collapse --
  // Both corner surfaces do the same single thing: open the transcript.
  const enterExpanded = () => patchUi({ mode: 'expanded' })
  on(pill, 'click', enterExpanded)

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
    // Turn the filler word over on the same beat, while the agent has yet to say
    // anything of its own. render() only runs on state changes, so it can't.
    if (j.phase === 'streaming' && !j.line && !j.disconnected) ticker.set(thinkingWord(j.startedAt), 'thinking')
  }

  // -- footer placement (single owner, focus-preserving) --
  // Exactly one control occupies the transcript footer; the other two stay alive in
  // the hidden stash so autofill, a half-typed draft and iOS focus all survive the
  // swap. Signed out you get the login form (or the invite form on an invite
  // landing); signed in, the composer.
  const footerControl = (): HTMLElement => {
    if (getState().auth === 'authed') return composer.el
    return getPendingInvite() ? setpwFooter : loginFooter
  }
  const placeFooter = (view: View) => {
    const active = view === 'expanded' ? footerControl() : null
    for (const node of [composer.el, loginFooter, setpwFooter]) {
      const target = node === active ? chat.footerEl : stash
      if (node.parentNode === target) continue
      const wasFocused = !!shadow.activeElement && node.contains(shadow.activeElement)
      target.appendChild(node)
      if (wasFocused && node === composer.el) composer.focus()
    }
  }

  // -- two-state toggle (rectangle ⇄ transcript) --
  const cycleState = () => {
    if (getState().ui.mode === 'expanded') collapseToCorner()
    else enterExpanded()
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

  on(miniBtn, 'click', enterExpanded)

  // Host pages can open the full experience without reaching into the Shadow
  // DOM. AgentKeyboard.com's hero uses this for its Interactive demo CTA.
  on(document, 'agent-keyboard:open', enterExpanded)

  // ponytail: no idle auto-collapse and no swipe-to-minimize any more. With no
  // middle state left, the only thing either could fold away is a transcript you
  // are reading. The transcript has its own collapse button and drag-to-dismiss.

  let lastView: View | null = null

  // The one line of text the corner rectangle carries. Resting copy tells you what
  // the bar is for; a job in flight, a finished job, an error or a sign-out all
  // borrow the same line rather than earning a surface of their own.
  const miniLine = (): string => {
    const { ui, job } = getState()
    if (ui.signingOut) return ui.signingOut
    if (job.phase === 'sending') return 'Sending…'
    if (job.phase === 'streaming') return job.disconnected ? 'reconnecting…' : job.line || thinkingWord(job.startedAt)
    if (job.phase === 'done') return job.summary
    if (job.phase === 'error') return job.message
    return getState().auth === 'authed' ? 'Whatsup?' : 'Log in'
  }

  const render = () => {
    const view = computeView()
    const { job } = getState()

    // Two surfaces: the corner box (rectangle, or the pill while streaming) and the
    // transcript. `bar` holds the pill, so mini/stream is which of the two shows.
    show(miniBtn, view === 'mini')
    show(bar, view === 'stream')
    show(pill, view === 'stream')

    const line = miniLine()
    miniCopy.textContent = line.replace(/\s+/g, ' ').trim()
    miniBtn.title = miniCopy.textContent
    // The agent-state colours still carry meaning at a glance, per the design system.
    miniBtn.classList.toggle('done', job.phase === 'done')
    miniBtn.classList.toggle('error', job.phase === 'error')
    // A long resting label needs a wider box than a status line; the copy ellipsizes.
    miniBtn.classList.toggle('ak-mini-long', line.length > 14)

    // pill state class
    pill.className = 'ak-pill'
    if (view === 'stream' && job.phase === 'streaming' && job.lineState === 'thinking') pill.classList.add('thinking')

    show(shimmer, view === 'stream')

    // stream row content
    if (view === 'stream') {
      if (lastView !== 'stream') ticker.clear()
      if (job.phase === 'sending') {
        ticker.set('Sending…', 'dim')
        runTimer() // the timer counts from the send tap, not the first frame
      } else if (job.phase === 'streaming') {
        const line = job.disconnected ? 'reconnecting…' : job.line || thinkingWord(job.startedAt)
        ticker.set(line, job.disconnected ? 'dim' : job.line ? job.lineState : 'thinking')
        runTimer()
      }
      const q = getQueued().length
      queueBadge.textContent = q ? `+${q}` : ''
      show(queueBadge, q > 0)
      if (timerId == null) timerId = setInterval(runTimer, 1000)
    } else {
      stopTimer()
    }

    if (view === 'expanded' && lastView !== 'expanded' && getPendingInvite()) {
      const inv = getPendingInvite()
      setpwLabel.textContent = inv?.email ? `Welcome — set a password for ${inv.email}` : 'Welcome — set a password'
    }

    placeFooter(view)
    // Leaving the transcript stashes the composer, so dictation can no longer be
    // seen — stop the mic rather than record invisibly. voice.teardown() leaves what
    // it already transcribed in the textarea, so it survives as a draft.
    if (lastView === 'expanded' && view !== 'expanded') composer.teardownVoice()

    lastView = view
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
