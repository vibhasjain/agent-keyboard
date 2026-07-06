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

const SESSION_UPDATE = {
  type: 'session.update',
  session: {
    type: 'transcription',
    audio: {
      input: {
        transcription: { model: 'gpt-realtime-whisper', language: 'en' },
        turn_detection: { type: 'server_vad', silence_duration_ms: 600 },
        noise_reduction: { type: 'near_field' },
      },
    },
  },
}

export interface VoiceController {
  toggle: () => void
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

  const connect = async () => {
    const mySeq = ++connectSeq
    const stale = () => mySeq !== connectSeq
    teardownLiveSession()
    h.onState('connecting')
    try {
      const tok = await api.realtimeToken()
      if (!tok.value) throw new Error('voice not configured')
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
        send(SESSION_UPDATE) // belt-and-braces; the token already carries config
        h.onState('live')
      }
      dc.onmessage = (e) => {
        let msg: { type?: string; delta?: string; transcript?: string }
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        // Server VAD heard speech → transcript is now in flight (spinner on).
        if (msg.type === 'input_audio_buffer.speech_started') {
          h.onTranscribing(true)
        } else if (msg.type === 'conversation.item.input_audio_transcription.delta' && msg.delta) {
          h.onPartial(msg.delta)
        } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
          h.onTranscribing(false) // this segment's transcript landed (spinner off)
          if (msg.transcript) h.onFinal(String(msg.transcript).trim())
        }
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const model = tok.model ? `?model=${encodeURIComponent(tok.model)}` : ''
      const sdpRes = await fetch(`https://api.openai.com/v1/realtime/calls${model}`, {
        method: 'POST',
        body: offer.sdp,
        headers: { Authorization: `Bearer ${tok.value}`, 'Content-Type': 'application/sdp' },
      })
      if (!sdpRes.ok) throw new Error(`realtime dial failed (${sdpRes.status})`)
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

  const stop = () => {
    connectSeq++ // cancels any in-flight connect at its next checkpoint
    teardownLiveSession()
    h.onTranscribing(false)
    h.onState('idle')
  }

  return {
    toggle: () => {
      const s = h.getState()
      if (s === 'idle' || s === 'error') void connect()
      else stop()
    },
    teardown: stop,
  }
}
