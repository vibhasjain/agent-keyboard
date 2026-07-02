// The durable-job store: one active job per site, and the reconnect layer that
// survives iOS backgrounding (tail90, handled ledger, attach/rehydrate, epoch
// guard) — simplified to ONE active job at a time.
//
// Fire-and-forget guarantee: we transition sending → streaming only AFTER the jobId
// is persisted to localStorage, so closing the tab never loses the job.

import { api, HttpError, type GitInfo } from './api'
import { hasStoredSession } from './auth'
import { CONFIG, lsKey } from './config'
import { uuid } from './dom'
import { getState, type LineState, setJob } from './state'

const BACKOFF = [1000, 2000, 5000, 10000]
const DONE_LINGER_MS = 8000

interface Persisted {
  jobId: string
  startedAt: number
  prompt: string
}

// -- controller state (module singleton) --------------------------------------
let jobId: string | null = null
let startedAt = 0
let prompt = ''
let lastPage = ''
let lastAttachmentIds: string[] = []
let terminal = false
let attempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let doneTimer: ReturnType<typeof setTimeout> | null = null
// Bumped every start / rehydrate; stale async handlers compare against it and bail.
let generation = 0

// Turns completed during this page load (rendered under any server-fetched history).
export interface LiveTurn { role: 'user' | 'assistant'; text: string; thumbs?: string[] }
const liveTurns: LiveTurn[] = []

export function getLiveTurns(): ReadonlyArray<LiveTurn> {
  return liveTurns
}

export function getActivePrompt(): string | null {
  const p = getState().job.phase
  return p === 'sending' || p === 'streaming' ? prompt : null
}

export function isBusy(): boolean {
  const p = getState().job.phase
  return p === 'sending' || p === 'streaming'
}

// Messages sent while a job is running queue client-side (like Claude Code)
// and dispatch as soon as the current job reaches a terminal state.
type QueuedInput = { text: string; attachmentIds?: string[]; page?: string; thumbs?: string[] }
const queue: QueuedInput[] = []

export function getQueued(): readonly QueuedInput[] {
  return queue
}

function dispatchQueue(): void {
  const next = queue.shift()
  if (next) setTimeout(() => start(next), 50)
}

// -- helpers ------------------------------------------------------------------
const tail90 = (t: unknown): string => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim()
  return s.length > 90 ? s.slice(-90) : s
}

const oneLine = (s: unknown, max = 140): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function lineStateFor(phase: string): LineState {
  if (phase === 'thinking') return 'thinking'
  if (phase === 'tool') return 'tool'
  return 'dim' // queued · syncing · starting · retrying
}

const PHASE_LABEL: Record<string, string> = {
  queued: 'Queued',
  syncing: 'Syncing the repo',
  starting: 'Starting up',
  thinking: 'Thinking',
  tool: 'Working',
  retrying: 'Retrying',
}

function persist(): void {
  if (!jobId) return
  try {
    localStorage.setItem(lsKey('active-job'), JSON.stringify({ jobId, startedAt, prompt } satisfies Persisted))
  } catch {
    /* storage blocked */
  }
}

function clearPersist(): void {
  try {
    localStorage.removeItem(lsKey('active-job'))
  } catch {
    /* ignore */
  }
}

function readPersist(): Persisted | null {
  try {
    const raw = localStorage.getItem(lsKey('active-job'))
    if (!raw) return null
    const p = JSON.parse(raw) as Persisted
    if (p && p.jobId) return p
  } catch {
    /* malformed */
  }
  return null
}

function markHandled(id: string): void {
  try {
    const key = lsKey('jobs-handled')
    const ids = JSON.parse(localStorage.getItem(key) || '[]') as string[]
    localStorage.setItem(key, JSON.stringify([id, ...ids.filter((x) => x !== id)].slice(0, 50)))
  } catch {
    /* ignore */
  }
}

function clearTimers(): void {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

// -- streaming state writes ---------------------------------------------------
interface StreamPatch {
  line?: string
  lineState?: LineState
  fullText?: string
  disconnected?: boolean
}

function setStreaming(patch: StreamPatch): void {
  if (!jobId) return
  const cur = getState().job
  const prev = cur.phase === 'streaming' ? cur : null
  setJob({
    phase: 'streaming',
    jobId,
    startedAt,
    line: patch.line ?? prev?.line ?? '',
    lineState: patch.lineState ?? prev?.lineState ?? 'dim',
    fullText: patch.fullText ?? prev?.fullText ?? '',
    disconnected: patch.disconnected ?? false,
  })
}

// -- frame handling -----------------------------------------------------------
function onFrame(name: string, data: Record<string, unknown>): void {
  if (name === 'job') {
    if (typeof data.job_id === 'string') {
      jobId = data.job_id
      if (!startedAt) startedAt = Date.now()
      persist() // fire-and-forget guarantee: persist BEFORE we show streaming
    }
    setStreaming({ disconnected: false })
    return
  }
  if (!jobId) return
  switch (name) {
    case 'status': {
      const phase = String(data.phase ?? '')
      const detail = String(data.detail ?? '') || PHASE_LABEL[phase] || 'Working'
      setStreaming({ line: detail, lineState: lineStateFor(phase) })
      break
    }
    case 'assistant': {
      const full = String(data.text ?? '')
      setStreaming({ fullText: full, line: tail90(full), lineState: 'assistant' })
      break
    }
    case 'result':
      terminal = true
      finishDone(data)
      break
    case 'error':
      terminal = true
      finishError(data)
      break
  }
}

function currentFullText(): string {
  const j = getState().job
  return j.phase === 'streaming' ? j.fullText : ''
}

function finishDone(data: Record<string, unknown>): void {
  const git = (data.git ?? {}) as GitInfo
  const reply = String(data.reply ?? '') || currentFullText()
  liveTurns.push({ role: 'user', text: prompt, thumbs: activeThumbs }, { role: 'assistant', text: reply })
  const sha7 = git.headSha ? String(git.headSha).slice(0, 7) : ''
  // "pushed" only when the agent actually changed something; pushed=true alone
  // just means the checkout matches origin (e.g. a read-only question).
  const shipped = !!git.changed && !!git.pushed
  const summary = shipped && sha7 ? `pushed ${sha7} — refresh to see it` : oneLine(reply) || 'Done'
  const finishedId = jobId
  markHandled(jobId!)
  clearPersist()
  reset()
  setJob({ phase: 'done', jobId: finishedId!, summary, ok: shipped || !git.dirty })
  if (doneTimer != null) clearTimeout(doneTimer)
  doneTimer = setTimeout(() => {
    const j = getState().job
    if (j.phase === 'done' && j.jobId === finishedId) setJob({ phase: 'idle' })
  }, DONE_LINGER_MS)
  dispatchQueue()
}

function makeRetry(): () => void {
  const p = prompt
  const ids = [...lastAttachmentIds]
  const page = lastPage
  return () => start({ text: p, attachmentIds: ids, page })
}

function finishError(data: Record<string, unknown>): void {
  const detail = String(data.detail ?? data.kind ?? '') || 'Something went wrong'
  const retry = makeRetry()
  markHandled(jobId ?? '')
  clearPersist()
  reset()
  setJob({ phase: 'error', message: detail, retry })
  dispatchQueue()
}

function reset(): void {
  terminal = true // any in-flight stream promise now no-ops
  jobId = null
  startedAt = 0
  attempt = 0
  clearTimers()
}

// -- disconnect / reconnect ---------------------------------------------------
function onDisconnect(gen: number): void {
  if (gen !== generation) return
  if (!jobId) {
    // Stream died before we ever learned the job id → can't re-attach.
    const retry = makeRetry()
    clearPersist()
    reset()
    setJob({ phase: 'error', message: 'Lost the connection before the job started.', retry })
    return
  }
  const j = getState().job
  if (j.phase === 'streaming') {
    setJob({ ...j, disconnected: true, line: 'reconnecting…', lineState: 'dim' })
  }
  scheduleReattach(gen)
}

function scheduleReattach(gen: number): void {
  clearTimers()
  const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)]
  attempt++
  reconnectTimer = setTimeout(() => reattach(gen, false), delay)
}

function reattach(gen: number, isBoot: boolean): void {
  if (gen !== generation || !jobId) return
  const myJob = jobId
  api
    .jobStream(myJob, onFrame)
    .then(() => {
      if (gen === generation && !terminal) onDisconnect(gen)
    })
    .catch((e: unknown) => {
      if (gen !== generation) return
      if (e instanceof HttpError && e.status === 404) {
        clearPersist()
        if (isBoot) {
          // Job long gone — the page just booted with a stale key. Clear silently.
          reset()
          setJob({ phase: 'idle' })
        } else {
          // Mid-session re-attach 404 ⇒ genuine failure.
          const retry = makeRetry()
          reset()
          setJob({ phase: 'error', message: 'That job is no longer available.', retry })
        }
      } else if (!terminal) {
        onDisconnect(gen)
      }
    })
}

// Immediate re-attempt when the tab returns to foreground or the network returns.
function wake(): void {
  const j = getState().job
  if (j.phase === 'streaming' && j.disconnected && jobId) {
    clearTimers()
    attempt = 0
    reattach(generation, false)
  }
}

let wakeBound = false
function bindWake(): void {
  if (wakeBound) return
  wakeBound = true
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) wake()
  })
  window.addEventListener('online', wake)
}

// -- public API ---------------------------------------------------------------
let activeThumbs: string[] | undefined

export function getActiveThumbs(): string[] | undefined {
  return isBusy() ? activeThumbs : undefined
}

export function start(input: { text: string; attachmentIds?: string[]; page?: string; thumbs?: string[] }): void {
  if (isBusy()) {
    // One active job per site — later sends queue and auto-dispatch on finish.
    queue.push(input)
    const j = getState().job
    if (j.phase === 'streaming') setJob({ ...j }) // nudge subscribers to render the queue
    return
  }
  bindWake()
  if (doneTimer != null) clearTimeout(doneTimer)
  clearTimers()
  generation++
  const gen = generation
  jobId = null
  startedAt = Date.now()
  prompt = input.text
  activeThumbs = input.thumbs?.length ? input.thumbs : undefined
  lastPage = input.page || location.pathname
  lastAttachmentIds = input.attachmentIds ?? []
  terminal = false
  attempt = 0
  setJob({ phase: 'sending' })

  const idemKey = uuid()
  api
    .sendMessage(
      CONFIG.site,
      { text: input.text, page: lastPage, idemKey, attachmentIds: lastAttachmentIds.length ? lastAttachmentIds : undefined },
      onFrame,
    )
    .then(() => {
      if (gen === generation && !terminal) onDisconnect(gen)
    })
    .catch((e: unknown) => {
      if (gen !== generation || terminal) return
      if (jobId) {
        onDisconnect(gen) // network blip after the job started → reconnect
      } else {
        const retry = makeRetry()
        clearPersist()
        reset()
        setJob({ phase: 'error', message: errMsg(e), retry })
      }
    })
}

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m || 'Could not reach the server.'
}

/** Boot policy: re-attach ONLY if an active-job key AND a stored session exist. */
export function bootRehydrate(): void {
  const saved = readPersist()
  if (!saved) return // ZERO requests
  if (!hasStoredSession()) return
  bindWake()
  generation++
  const gen = generation
  jobId = saved.jobId
  startedAt = saved.startedAt || Date.now()
  prompt = saved.prompt || ''
  lastPage = location.pathname
  lastAttachmentIds = []
  terminal = false
  attempt = 0
  setJob({ phase: 'streaming', jobId, startedAt, line: 'reconnecting…', lineState: 'dim', fullText: '', disconnected: true })
  reattach(gen, true)
}
