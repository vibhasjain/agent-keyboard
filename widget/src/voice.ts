// Dictation via OpenAI Realtime transcription. A transcription-only session: no
// INSTRUCTIONS, TOOLS, or tool-call handling, and no audio sink (transcription
// sessions emit no audio, so we never attach ontrack). We only consume
// input-audio transcripts.

import { api } from './api'
import type { VoiceState } from './state'

// One live WebRTC session, ever — rapid toggles must not leave an orphan talking.
let liveSession: { pc: RTCPeerConnection; dc: RTCDataChannel | null; stream: MediaStream | null } | null = null
let connectSeq = 0

function teardownLiveSession(): void {
  if (!liveSession) return
  try {
    liveSession.dc?.close()
    liveSession.stream?.getTracks().forEach((t) => t.stop())
    liveSession.pc.getSenders().forEach((s) => s.track?.stop())
    liveSession.pc.close()
  } catch {
    /* already closed */
  }
  liveSession = null
}

const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-transcribe'

function supportsTurnDetection(model: string): boolean {
  return model !== 'gpt-realtime-whisper'
}

function sessionUpdate(model: string): Record<string, unknown> {
  const input: Record<string, unknown> = {
    transcription: { model, language: 'en' },
    noise_reduction: { type: 'near_field' },
  }
  if (supportsTurnDetection(model)) {
    input.turn_detection = { type: 'server_vad', silence_duration_ms: 600 }
  }
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: { input },
    },
  }
}

export interface VoiceController {
  toggle: () => void
  // Commit any in-flight dictation and resolve once its transcript is folded in —
  // await before sending so nothing spoken is dropped. No-op when not dictating.
  flush: () => Promise<void>
  teardown: () => void
}

export interface VoiceHandlers {
  onState: (s: VoiceState, error?: string) => void
  // Partial (live) and final (folded) transcript deltas for the textarea.
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  // True while speech is detected and its transcript is still pending (drives the
  // inline "transcribing" spinner), false once that segment's transcript lands.
  onTranscribing: (active: boolean) => void
  getState: () => VoiceState
}

export function makeVoice(h: VoiceHandlers): VoiceController {
  const send = (obj: unknown) => liveSession?.dc?.send(JSON.stringify(obj))
  // Non-null while a committed buffer is being transcribed (mic stopped → waiting
  // for the transcript). Doubles as the "we're finishing" flag.
  let finishTimer: ReturnType<typeof setTimeout> | null = null
  const clearFinish = () => {
    if (finishTimer) {
      clearTimeout(finishTimer)
      finishTimer = null
    }
  }
  // Callers awaiting the in-flight transcript (send() flushes before reading the
  // text so nothing spoken is lost). Resolved once the transcript lands (or we
  // give up), so they never hang.
  let flushResolvers: Array<() => void> = []
  const settleFlush = () => {
    const rs = flushResolvers
    flushResolvers = []
    rs.forEach((r) => r())
  }

  const connect = async () => {
    const mySeq = ++connectSeq
    const stale = () => mySeq !== connectSeq
    teardownLiveSession()
    h.onState('connecting')
    try {
      const tok = await api.realtimeToken()
      if (!tok.value) throw new Error('voice not configured')
      const transcribeModel = tok.model || DEFAULT_TRANSCRIBE_MODEL
      if (stale()) return

      const pc = new RTCPeerConnection()
      liveSession = { pc, dc: null, stream: null }

      // Mic in. (No ontrack: transcription sessions produce no audio to play.)
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (stale()) {
        mic.getTracks().forEach((t) => t.stop())
        pc.close()
        return
      }
      if (liveSession) liveSession.stream = mic
      mic.getTracks().forEach((t) => pc.addTrack(t, mic))

      const dc = pc.createDataChannel('oai-events')
      if (liveSession?.pc === pc) liveSession.dc = dc
      dc.onopen = () => {
        send(sessionUpdate(transcribeModel)) // belt-and-braces; the token already carries config
        h.onState('live')
      }
      dc.onmessage = (e) => {
        let msg: { type?: string; delta?: string; transcript?: string }
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        // VAD-capable models can produce deltas while recording. Manual flush()
        // still commits trailing audio before Send reads the textarea.
        if (msg.type === 'input_audio_buffer.speech_started') {
          h.onTranscribing(true)
        } else if (msg.type === 'conversation.item.input_audio_transcription.delta' && msg.delta) {
          h.onPartial(msg.delta)
        } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
          const finishing = finishTimer != null || flushResolvers.length > 0
          clearFinish()
          if (msg.transcript) h.onFinal(String(msg.transcript).trim()) // fold text in BEFORE resolving flush
          h.onTranscribing(false)
          if (finishing) {
            teardownLiveSession()
            h.onState('idle')
            settleFlush()
          }
        } else if (msg.type === 'error' && finishTimer) {
          // e.g. committing an empty/too-short buffer — don't hang on the spinner.
          clearFinish()
          h.onTranscribing(false)
          teardownLiveSession()
          h.onState('idle')
          settleFlush()
        }
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      // The ephemeral token already carries the transcription session config.
      // Do not pass tok.model here: it is the transcription model, not a
      // realtime transport model, and /realtime/calls rejects it with 400.
      const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offer.sdp,
        headers: { Authorization: `Bearer ${tok.value}`, 'Content-Type': 'application/sdp' },
      })
      if (!sdpRes.ok) throw new Error('Voice connection failed')
      const answerSdp = await sdpRes.text()
      if (stale()) {
        teardownLiveSession()
        return
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    } catch (e) {
      if (mySeq !== connectSeq) return
      teardownLiveSession()
      h.onTranscribing(false)
      const err = e as Error
      if (err && err.name === 'NotAllowedError') {
        h.onState('error', 'Mic blocked — enable it in Safari settings')
      } else {
        h.onState('error', err?.message || 'Voice unavailable')
      }
    }
  }

  // Hard stop: cancel everything now, no transcript wait (used when leaving the
  // composer). Resolves any pending flush so an awaiting send() never hangs.
  const stop = () => {
    connectSeq++ // cancels any in-flight connect at its next checkpoint
    clearFinish()
    teardownLiveSession()
    h.onTranscribing(false)
    h.onState('idle')
    settleFlush()
  }

  // Graceful stop: stop capturing, commit the buffered audio, and RESOLVE ONLY
  // once the transcript has landed (folded into the composer by onFinal). Both the
  // mic-off tap and send() call this, so whatever was spoken is captured before it
  // matters — nothing is lost by hitting send without tapping the mic off first.
  // A no-op (resolves immediately) when there's no live session.
  const flush = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const s = liveSession
      if (!s || s.dc?.readyState !== 'open') return resolve()
      flushResolvers.push(resolve)
      if (finishTimer) return // already committed; this caller settles with it
      s.stream?.getTracks().forEach((t) => t.stop())
      s.pc.getSenders().forEach((sn) => sn.track?.stop())
      h.onTranscribing(true)
      send({ type: 'input_audio_buffer.commit' })
      finishTimer = setTimeout(() => {
        finishTimer = null
        h.onTranscribing(false)
        teardownLiveSession()
        h.onState('idle')
        settleFlush()
      }, 8000)
    })

  return {
    toggle: () => {
      const s = h.getState()
      if (s === 'idle' || s === 'error') void connect()
      else void flush()
    },
    flush,
    teardown: stop,
  }
}
