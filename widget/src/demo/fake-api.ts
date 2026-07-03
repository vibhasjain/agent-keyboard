// Swap the widget's HTTP client for scripted fakes. `api` is a mutable object
// literal, so reassigning its methods reroutes every network call into timed
// frame playback — no server, no auth, the real jobstore/bar/chat pipeline.

import { api, type ConversationMessage, type SseFrameHandler, type UploadResult } from '../api'
import { prefersReducedMotion } from '../dom'

/** One scripted SSE frame: [offset from the call, event name, payload]. The
 *  event names + shapes match what jobstore.onFrame handles:
 *    job{job_id} · status{phase,detail} · assistant{text} · result{reply,git} · error{detail} */
export type Frame = [atMs: number, event: string, data: Record<string, unknown>]

export interface SceneScript {
  /** Frames sendMessage (and a jobStream re-attach) plays, relative to the call. */
  send?: Frame[]
  /** Photo upload: sweep onProgress 0→1 over durationMs, then resolve. */
  upload?: { durationMs: number; result?: UploadResult }
  /** Fixed history for the expanded chat. */
  conversation?: { messages: ConversationMessage[]; cursor: string | null }
}

function playFrames(frames: Frame[], onFrame: SseFrameHandler): Promise<void> {
  // Reduced motion: skip the stream. Deliver just the job frame (sets the id)
  // and the terminal frame (result/error) so the pipeline lands on its static
  // end-state with no shimmer, ticker, or token animation.
  if (prefersReducedMotion()) {
    const job = frames.find(([, e]) => e === 'job')
    const terminal = [...frames].reverse().find(([, e]) => e === 'result' || e === 'error')
    if (job) onFrame(job[1], job[2])
    if (terminal) onFrame(terminal[1], terminal[2])
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let last = 0
    for (const [at, event, data] of frames) {
      last = Math.max(last, at)
      setTimeout(() => onFrame(event, data), at)
    }
    // Resolve just after the terminal frame so jobstore's post-stream .then()
    // sees `terminal === true` and never treats it as a dropped connection.
    setTimeout(resolve, last + 40)
  })
}

function fakeUpload(
  script: SceneScript['upload'],
  onProgress?: (p: number) => void,
): Promise<UploadResult> {
  const duration = script?.durationMs ?? 1600
  const result = script?.result ?? { id: 'up_demo', path: 'uploads/up_demo.jpg' }
  if (prefersReducedMotion()) {
    onProgress?.(1)
    return Promise.resolve(result)
  }
  return new Promise((resolve) => {
    const start = performance.now()
    const tick = (): void => {
      const p = Math.min(1, (performance.now() - start) / duration)
      onProgress?.(p)
      if (p < 1) requestAnimationFrame(tick)
      else resolve(result)
    }
    requestAnimationFrame(tick)
  })
}

export function installFakeApi(script: SceneScript): void {
  api.sendMessage = (_siteId, _body, onFrame) => playFrames(script.send ?? [], onFrame)
  api.jobStream = (_jobId, onFrame) => playFrames(script.send ?? [], onFrame)
  api.conversation = () =>
    Promise.resolve(script.conversation ?? { messages: [], cursor: null })
  api.uploadPhoto = (_siteId, _file, _filename, onProgress) => fakeUpload(script.upload, onProgress)
  api.listJobs = () => Promise.resolve({ jobs: [] })
  api.realtimeToken = () => Promise.resolve({ value: 'demo', session_type: 'transcription' })
}
