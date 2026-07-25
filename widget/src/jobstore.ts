// The durable-job store: one active job per site, and the reconnect layer that
// survives iOS backgrounding (tail90, handled ledger, attach/rehydrate, epoch
// guard) — simplified to ONE active job at a time.
//
// Fire-and-forget guarantee: we transition sending → streaming only AFTER the jobId
// is persisted to localStorage, so closing the tab never loses the job.

import { api, HttpError, type ConversationMessage, type GitInfo } from './api'
import { hasStoredSession } from './auth'
import { CONFIG, lsKey } from './config'
import { uuid } from './dom'
import { getState, patchUi, type LineState, type Subagent, type TodoItem, setJob } from './state'

const BACKOFF = [1000, 2000, 5000, 10000]
const DONE_LINGER_MS = 8000
// Reconnect can never spin forever. A "running" job older than the server's max
// session life is a ghost (the server killed it long ago), and even a live job
// gives up after enough consecutive failed reattaches — this is what un-wedges the
// iOS-app "stuck reconnecting…" case (dead session + expired token, timers frozen
// by backgrounding). `attempt` resets on wake; this fail counter survives it and
// only resets when a frame actually flows.
const MAX_SESSION_MS = 70 * 60_000 // server session cap (1h) + buffer
const MAX_REATTACH_FAILS = 12
let totalReattachFails = 0

interface Persisted {
  jobId: string
  startedAt: number
  prompt: string
}

// -- controller state (module singleton) --------------------------------------
let jobId: string | null = null
let startedAt = 0
let prompt = ''
let activeIdemKey = ''
let lastPage = ''
let lastAttachmentIds: string[] = []
let terminal = false
let attempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let doneTimer: ReturnType<typeof setTimeout> | null = null
// Bumped every start / rehydrate; stale async handlers compare against it and bail.
let generation = 0
let restartInFlight = false

// Streaming session (M2/M3): when the active job is a long-lived session, a
// `result` frame is a TURN boundary (not the end), and follow-ups are injected
// into it via the append endpoint instead of queuing a fresh job. A `closed`
// frame ends the session. pendingUserTexts pairs each turn's reply with the user
// text that produced it (FIFO): head = the turn being processed now.
let sessionStreaming = false
let pendingUserTexts: string[] = []

// Turns completed during this page load (rendered under any server-fetched history).
// `thumbs` = the user's attached photos; `files` = non-image attachments;
// `images` = images the agent chose to show.
export interface LiveTurn { role: 'user' | 'assistant' | 'error'; text: string; thumbs?: string[]; files?: string[]; images?: string[] }
const liveTurns: LiveTurn[] = []

export function getLiveTurns(): ReadonlyArray<LiveTurn> {
  return liveTurns
}

function normTurnText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function sameTerminalText(a: string, b: string): boolean {
  const x = normTurnText(a)
  const y = normTurnText(b)
  if (!x || !y) return false
  if (x === y) return true
  return Math.min(x.length, y.length) >= 12 && (x.includes(y) || y.includes(x))
}

// Bumped when a "clear context" lands, so the transcript can drop its cached
// server history and refetch the now-empty conversation exactly once.
let clearEpoch = 0
export function getClearEpoch(): number {
  return clearEpoch
}

// Bumped on every send from this device, so the expanded chat can force-scroll to
// the just-sent message even if the user had scrolled up (e.g. a voice/external send).
let sendEpoch = 0
export function getSendEpoch(): number {
  return sendEpoch
}

/**
 * Prune liveTurns already present in server history so a turn never renders
 * twice (history is fetched lazily — a turn that completed before the first
 * expand exists in BOTH). History ids are Claude-session uuids with no relation
 * to idemKey, so matching keys on normalized user-turn text; positions must
 * strictly increase so repeated identical prompts pair 1:1. An attachment-only
 * turn has empty text — it may only match a history user turn that is also
 * attachment-only, never an arbitrary empty row.
 * Returns whether anything was removed.
 */
export function reconcileLiveTurns(history: ConversationMessage[]): boolean {
  if (!liveTurns.length || !history.length) return false
  const drop = new Set<number>()
  let pos = 0
  for (let i = 0; i < liveTurns.length; i++) {
    const t = liveTurns[i]
    if (t.role !== 'user') continue
    // Agent-shown images live ONLY on the live turn (history never carries
    // them; the files are one-turn transient) — never prune that pair.
    if (liveTurns[i + 1]?.role === 'assistant' && liveTurns[i + 1]?.images?.length) continue
    const target = normTurnText(t.text)
    for (let j = pos; j < history.length; j++) {
      const m = history[j]
      if (m.role !== 'user') continue
      const matches = target
        ? normTurnText(m.text) === target
        : (!!t.thumbs?.length || !!t.files?.length) && ((m.attachments ?? m.photos ?? 0) > 0) && !normTurnText(m.text)
      if (matches) {
        drop.add(i)
        const liveReply = liveTurns[i + 1]
        const liveError = liveTurns[i + 2]?.role === 'error' ? liveTurns[i + 2] : liveTurns[i + 1]?.role === 'error' ? liveTurns[i + 1] : null
        const following = history.slice(j + 1)
        const nextUser = following.findIndex((h) => h.role === 'user')
        const historyReply = (nextUser >= 0 ? following.slice(0, nextUser) : following).find((h) => h.role === 'assistant')
        if (liveReply?.role === 'assistant') drop.add(i + 1)
        if (
          liveError &&
          ((liveReply?.role === 'assistant' && sameTerminalText(liveReply.text, liveError.text)) ||
            (!!historyReply && sameTerminalText(historyReply.text, liveError.text)))
        ) {
          drop.add(liveTurns.indexOf(liveError))
        }
        pos = j + 1
        break
      }
    }
  }
  if (!drop.size) return false
  for (let i = liveTurns.length - 1; i >= 0; i--) if (drop.has(i)) liveTurns.splice(i, 1)
  return true
}

export function getActivePrompt(): string | null {
  const p = getState().job.phase
  if (p !== 'sending' && p !== 'streaming') return null
  return (sessionStreaming ? (pendingUserTexts[0] ?? prompt) : prompt) || null
}

/** Follow-ups injected into the live session that haven't started their turn yet
 *  (rendered dim, like the client-side queue). */
export function getPendingFollowups(): readonly string[] {
  return sessionStreaming ? pendingUserTexts.slice(1) : []
}

export function isBusy(): boolean {
  const p = getState().job.phase
  return p === 'sending' || p === 'streaming'
}

/** Forcefully stop the active job. The server publishes a terminal 'stopped'
 *  error on the job's stream, which flows back through onFrame → finishError. */
export async function stop(): Promise<void> {
  if (jobId && isBusy()) await api.cancelJob(jobId).catch(() => {})
}

// Messages sent while a job is running queue client-side (like Claude Code)
// and dispatch as soon as the current job reaches a terminal state.
type QueuedInput = { text: string; attachmentIds?: string[]; page?: string; thumbs?: string[]; files?: string[]; idemKey?: string }
const queue: QueuedInput[] = []

export function getQueued(): readonly QueuedInput[] {
  return queue
}

function dispatchQueue(): void {
  if (restartInFlight) return
  const next = queue.shift()
  if (next) setTimeout(() => start(next), 50)
}

// -- durable outbox -------------------------------------------------------------
// Queued and in-flight sends persist to localStorage so a reload never loses a
// message ("it never goes out of the queue"). The in-flight entry closes the
// POST→job-frame gap: boot re-sends the same idemKey and the server re-tails the
// original job instead of running it twice (10-min server TTL). Two tabs
// restoring the same outbox POST the same idemKey — the server re-tails one
// job, so that's safe by design.
interface OutboxItem {
  idemKey: string
  text: string
  page?: string
  attachmentIds?: string[]
  ts: number
  inFlight?: boolean
}

const OUTBOX_QUEUED_TTL_MS = 30 * 60_000 // stale asks shouldn't auto-fire hours later
const OUTBOX_INFLIGHT_TTL_MS = 10 * 60_000 // matches the server's idemKey re-tail TTL
const OUTBOX_CAP = 10

function readOutbox(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(lsKey('outbox'))
    if (!raw) return []
    const parsed = JSON.parse(raw) as { v?: number; items?: OutboxItem[] }
    const now = Date.now()
    return (parsed.items || []).filter(
      (it) =>
        it &&
        typeof it.idemKey === 'string' &&
        typeof it.text === 'string' &&
        now - (it.ts || 0) < (it.inFlight ? OUTBOX_INFLIGHT_TTL_MS : OUTBOX_QUEUED_TTL_MS),
    )
  } catch {
    return []
  }
}

function writeOutbox(items: OutboxItem[]): void {
  try {
    localStorage.setItem(lsKey('outbox'), JSON.stringify({ v: 1, items: items.slice(-OUTBOX_CAP) }))
  } catch {
    /* storage blocked */
  }
}

function outboxUpsert(item: OutboxItem): void {
  const items = readOutbox().filter((it) => it.idemKey !== item.idemKey)
  items.push(item)
  writeOutbox(items)
}

function outboxRemove(idemKey: string): void {
  if (!idemKey) return
  writeOutbox(readOutbox().filter((it) => it.idemKey !== idemKey))
}

// -- helpers ------------------------------------------------------------------
// The ticker/summary are single plain-text lines — reduce markdown links to
// their label there (the clickable anchor renders in the transcript).
const stripMdLinks = (s: string): string => s.replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')

const tail90 = (t: unknown): string => {
  const s = stripMdLinks(String(t ?? '')).replace(/\s+/g, ' ').trim()
  return s.length > 90 ? s.slice(-90) : s
}

const oneLine = (s: unknown, max = 140): string => {
  const t = stripMdLinks(String(s ?? '')).replace(/\s+/g, ' ').trim()
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
    localStorage.setItem(lsKey('last-job-at'), String(Date.now())) // activity flag for boot-time discovery
  } catch {
    /* storage blocked */
  }
}

// Once this device SEES a job finish, boot-time discovery has nothing to
// recover — clear the activity flag so idle page loads stay zero-request.
function clearActivityFlag(): void {
  try {
    localStorage.removeItem(lsKey('last-job-at'))
  } catch {
    /* ignore */
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

function readHandled(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(lsKey('jobs-handled')) || '[]') as string[])
  } catch {
    return new Set()
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
  todos?: TodoItem[]
  subagents?: Subagent[]
  idle?: boolean
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
    todos: patch.todos ?? prev?.todos,
    subagents: patch.subagents ?? prev?.subagents,
    // Any streaming frame that isn't a turn-complete means work is happening, so
    // idle defaults false — only onTurnComplete (nothing queued) sets it true.
    idle: patch.idle ?? false,
    disconnected: patch.disconnected ?? false,
  })
}

// Stamp each running sub-agent with a client-side start time (for the live timer),
// preserving it across `subagents` frames and dropping ones that finished.
const subagentStartedAt = new Map<string, number>()
function reconcileSubagents(items: { id: string; desc: string }[]): Subagent[] {
  const ids = new Set(items.map((s) => s.id))
  for (const id of [...subagentStartedAt.keys()]) if (!ids.has(id)) subagentStartedAt.delete(id)
  return items.map((s) => {
    let at = subagentStartedAt.get(s.id)
    if (at == null) {
      at = Date.now()
      subagentStartedAt.set(s.id, at)
    }
    return { id: s.id, desc: s.desc, startedAt: at }
  })
}

// -- frame handling -----------------------------------------------------------
function onFrame(name: string, data: Record<string, unknown>): void {
  totalReattachFails = 0 // a frame flowed → the connection is healthy again
  if (name === 'job') {
    if (typeof data.job_id === 'string') {
      jobId = data.job_id
      sessionStreaming = data.streaming === true
      if (!startedAt) startedAt = Date.now()
      persist() // fire-and-forget guarantee: persist BEFORE we show streaming
      outboxRemove(activeIdemKey) // the durable active-job key owns recovery now
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
    case 'todos': {
      setStreaming({ todos: Array.isArray(data.items) ? (data.items as TodoItem[]) : [] })
      break
    }
    case 'subagents': {
      const items = Array.isArray(data.items) ? (data.items as { id: string; desc: string }[]) : []
      setStreaming({ subagents: reconcileSubagents(items) })
      break
    }
    case 'result':
      // A streaming session's `result` is a TURN boundary (session stays open);
      // a classic result ends the job.
      if (data.open === true) {
        onTurnComplete(data)
      } else {
        terminal = true
        finishDone(data)
      }
      break
    case 'closed':
      terminal = true
      finishSession()
      break
    case 'error':
      terminal = true
      finishError(data)
      break
  }
}

function frameHandler(gen: number): (name: string, data: Record<string, unknown>) => void {
  return (name, data) => {
    if (gen === generation) onFrame(name, data)
  }
}

function currentFullText(): string {
  const j = getState().job
  return j.phase === 'streaming' ? j.fullText : ''
}

// Assistant-shown images arrive as [{name}] on the result frame; build the URLs
// the widget loads them from (the site's open asset route on the API origin).
function imageUrls(data: Record<string, unknown>): string[] | undefined {
  const raw = Array.isArray(data.images) ? (data.images as Array<{ name?: unknown }>) : []
  const urls = raw
    .map((i) => String(i?.name ?? ''))
    .filter((n) => /^[a-f0-9-]{36}\.(png|jpe?g|gif|webp)$/i.test(n))
    .map((n) => `${CONFIG.api}/sites/${encodeURIComponent(CONFIG.site)}/assets/${n}`)
  return urls.length ? urls : undefined
}

// A streaming turn finished: move the completed [user, assistant] pair to the
// static transcript and reset the live block for the next turn. The job stays
// streaming/open.
// Strip trailing transient error rows — a later successful turn/result proves any
// preceding error (a reconnect blip, a server-restart 'interrupted') was recoverable.
function dropTrailingErrors(): void {
  while (liveTurns.length && liveTurns[liveTurns.length - 1].role === 'error') liveTurns.pop()
}

function onTurnComplete(data: Record<string, unknown>): void {
  dropTrailingErrors()
  sessionStreaming = true
  const reply = String(data.reply ?? '') || currentFullText()
  const userText = pendingUserTexts.shift() ?? prompt
  if (userText || activeThumbs?.length || activeFiles?.length) {
    liveTurns.push({ role: 'user', text: userText, thumbs: activeThumbs, files: activeFiles })
  }
  liveTurns.push({ role: 'assistant', text: reply, images: imageUrls(data) })
  activeThumbs = undefined // attachments belong to the opening turn only
  activeFiles = undefined
  prompt = pendingUserTexts[0] ?? ''
  setStreaming({
    fullText: '',
    line: pendingUserTexts.length ? 'Working…' : '',
    lineState: 'dim',
    // No queued follow-up → the session is just resting (open for injection). Mark
    // it idle so the bar shows the plain composer, not a spinner+timer "working" pill.
    idle: pendingUserTexts.length === 0,
  })
}

// The streaming session closed (idle / lifetime cap / stop). Turns already landed
// per-turn, so just finalize — no extra bubble.
function finishSession(): void {
  const finishedId = jobId ?? `sess-${Date.now()}`
  markHandled(jobId ?? '')
  clearPersist()
  clearActivityFlag()
  outboxRemove(activeIdemKey)
  reset()
  setJob({ phase: 'done', jobId: finishedId, summary: 'Session closed', ok: true })
  if (doneTimer != null) clearTimeout(doneTimer)
  doneTimer = setTimeout(() => {
    const j = getState().job
    if (j.phase === 'done' && j.jobId === finishedId) setJob({ phase: 'idle' })
  }, DONE_LINGER_MS)
  dispatchQueue()
}

function finishDone(data: Record<string, unknown>): void {
  dropTrailingErrors()
  const git = (data.git ?? {}) as GitInfo
  const reply = String(data.reply ?? '') || currentFullText()
  // A job attached without its prompt (cross-device discovery) pushes no live
  // turn — an empty user bubble can't reconcile against history; the next
  // history fetch renders the turn canonically instead.
  if (prompt || activeThumbs?.length || activeFiles?.length) {
    liveTurns.push(
      { role: 'user', text: prompt, thumbs: activeThumbs, files: activeFiles },
      { role: 'assistant', text: reply, images: imageUrls(data) },
    )
  }
  const sha7 = git.headSha ? String(git.headSha).slice(0, 7) : ''
  // "pushed" only when the agent actually changed something; pushed=true alone
  // just means the checkout matches origin (e.g. a read-only question).
  const shipped = !!git.changed && !!git.pushed
  const summary = shipped && sha7 ? `pushed ${sha7} — refresh to see it` : oneLine(reply) || 'Done'
  const finishedId = jobId
  markHandled(jobId!)
  clearPersist()
  clearActivityFlag()
  outboxRemove(activeIdemKey) // belt-and-suspenders: the job-frame removal may have failed
  reset()
  // "clear context": the server started a fresh session, so wipe the client-side
  // transcript too (chat.ts refetches the now-empty history off the clear epoch).
  const cleared = data.cleared === true
  if (cleared) {
    liveTurns.length = 0
    queue.length = 0
    writeOutbox([])
    clearEpoch++
  }
  setJob({ phase: 'done', jobId: finishedId!, summary, ok: shipped || !git.dirty, cleared })
  if (doneTimer != null) clearTimeout(doneTimer)
  doneTimer = setTimeout(() => {
    const j = getState().job
    if (j.phase === 'done' && j.jobId === finishedId) setJob({ phase: 'idle' })
  }, DONE_LINGER_MS)
  dispatchQueue()
}

function finishError(data: Record<string, unknown>): void {
  const detail = String(data.detail ?? data.kind ?? '') || 'Something went wrong'
  const kind = String(data.kind ?? '')
  // Infrastructural terminals (server restart mid-session, evicted job) aren't the
  // agent's fault and self-recover — keep them pill-only, never a persistent row.
  const transient = kind === 'interrupted' || kind === 'not_found'
  const partial = currentFullText()
  if (prompt || activeThumbs?.length || activeFiles?.length) {
    liveTurns.push({ role: 'user', text: prompt, thumbs: activeThumbs, files: activeFiles })
  }
  if (partial) liveTurns.push({ role: 'assistant', text: partial })
  if (!transient && (!partial || !sameTerminalText(partial, detail))) liveTurns.push({ role: 'error', text: detail })
  markHandled(jobId ?? '')
  clearPersist()
  clearActivityFlag()
  // Drop the failed send from the outbox — silently auto-refiring it on the next
  // reload would be surprising. The error pill opens the transcript instead.
  outboxRemove(activeIdemKey)
  reset()
  setJob({ phase: 'error', message: detail })
  dispatchQueue()
}

function reset(): void {
  terminal = true // any in-flight stream promise now no-ops
  jobId = null
  startedAt = 0
  attempt = 0
  totalReattachFails = 0
  sessionStreaming = false
  pendingUserTexts = []
  subagentStartedAt.clear()
  clearTimers()
}

export function beginRestart(): void {
  restartInFlight = true
}

export function endRestartAttempt(): void {
  restartInFlight = false
}

/** Local half of the server restart action: drop chat tail, queued sends, active
 *  reattach state, and force the expanded transcript to refetch the fresh empty
 *  conversation. Call only after the server confirms reset+rotate completed. */
export function clearAfterRestart(): void {
  const finishedId = jobId || `restart-${Date.now()}`
  generation++ // ignore any frames from the pre-restart stream
  restartInFlight = false
  if (jobId) markHandled(jobId)
  clearTimers()
  clearPersist()
  clearActivityFlag()
  writeOutbox([])
  queue.length = 0
  liveTurns.length = 0
  sessionStreaming = false
  pendingUserTexts = []
  prompt = ''
  activeIdemKey = ''
  lastPage = ''
  lastAttachmentIds = []
  activeThumbs = undefined
  activeFiles = undefined
  terminal = true
  jobId = null
  startedAt = 0
  attempt = 0
  clearEpoch++
  setJob({ phase: 'done', jobId: finishedId, summary: 'Restarted — clean slate', ok: true, cleared: true })
  if (doneTimer != null) clearTimeout(doneTimer)
  doneTimer = setTimeout(() => {
    const j = getState().job
    if (j.phase === 'done' && j.jobId === finishedId) setJob({ phase: 'idle' })
  }, DONE_LINGER_MS)
}

// -- disconnect / reconnect ---------------------------------------------------
function onDisconnect(gen: number): void {
  if (gen !== generation) return
  if (!jobId) {
    // Stream died before we ever learned the job id → can't re-attach. The job
    // may still have started server-side, so the outbox entry stays: a reload
    // re-sends the same key, which the server re-tails instead of re-running.
    clearPersist()
    reset()
    setJob({ phase: 'error', message: 'Lost the connection before the job started.' })
    dispatchQueue()
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
  totalReattachFails++
  reconnectTimer = setTimeout(() => reattach(gen, false), delay)
}

function reattach(gen: number, isBoot: boolean): void {
  if (gen !== generation || !jobId) return
  // Ghost streaming session: the server caps a session at ~1h, so a much-older
  // "running" streaming job is dead — stop trying and clear it silently (the
  // composer returns; a new message starts fresh). This is the main fix for the
  // iOS-app "stuck reconnecting…" wedge. Gated to streaming so a long-running
  // classic job (now uncapped) is never killed just for a disconnect.
  if (sessionStreaming && startedAt && Date.now() - startedAt > MAX_SESSION_MS) {
    clearPersist()
    clearActivityFlag()
    reset()
    setJob({ phase: 'idle' })
    dispatchQueue()
    return
  }
  // Belt-and-suspenders: give up after too many consecutive failed reattaches with
  // nothing flowing (survives wake resets), so reconnect can never spin forever.
  if (totalReattachFails > MAX_REATTACH_FAILS) {
    clearPersist()
    reset()
    setJob({ phase: 'error', message: "Couldn't reconnect — send a message to retry." })
    dispatchQueue()
    return
  }
  const myJob = jobId
  api
    .jobStream(myJob, frameHandler(gen))
    .then(() => {
      if (gen === generation && !terminal) onDisconnect(gen)
    })
    .catch((e: unknown) => {
      if (gen !== generation) return
      if (e instanceof HttpError && e.status < 500) {
        // Auth blip: the token refresh transiently failed (e.g. server mid-redeploy)
        // but the session is still stored — retry instead of forcing a re-login.
        // doRefresh only wipes on a real auth rejection, so a wiped session (no
        // stored session) falls through to the terminal "sign in again" below.
        if ((e.status === 401 || e.status === 403) && hasStoredSession()) {
          if (!terminal) onDisconnect(gen)
          return
        }
        clearPersist()
        if (isBoot && e.status === 404) {
          // Job long gone — the page just booted with a stale key. Clear silently.
          reset()
          setJob({ phase: 'idle' })
        } else {
          const message =
            e.status === 401 || e.status === 403
              ? 'Sign in again to reconnect.'
              : e.status === 404
                ? 'That job is no longer available.'
                : `Could not reconnect (${e.status}).`
          // Mid-session non-retryable response ⇒ genuine failure.
          reset()
          setJob({ phase: 'error', message })
        }
        // Sends queued behind the dead job (e.g. restored from the outbox at
        // boot) must not strand — drain like every other terminal path.
        dispatchQueue()
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
let activeFiles: string[] | undefined

export function getActiveThumbs(): string[] | undefined {
  return isBusy() ? activeThumbs : undefined
}

export function getActiveFiles(): string[] | undefined {
  return isBusy() ? activeFiles : undefined
}

export function start(input: {
  text: string
  attachmentIds?: string[]
  page?: string
  thumbs?: string[]
  files?: string[]
  idemKey?: string
}): void {
  sendEpoch++ // let the transcript force-scroll to this send
  if (isBusy()) {
    // Live streaming session → inject the follow-up into the running job rather
    // than queuing a fresh one. Text-only (the append endpoint takes no files).
    if (sessionStreaming && jobId && input.text.trim() && !input.attachmentIds?.length) {
      const t = input.text
      pendingUserTexts.push(t)
      const js = getState().job
      if (js.phase === 'streaming') setJob({ ...js, idle: false }) // resting → working immediately
      else if (js.phase === 'sending') setJob({ ...js })
      api.appendMessage(CONFIG.site, jobId, t).catch(() => {
        // Append failed → fall back to the client-side queue.
        const i = pendingUserTexts.lastIndexOf(t)
        if (i >= 0) pendingUserTexts.splice(i, 1)
        const fq: QueuedInput = { ...input, idemKey: input.idemKey || uuid() }
        queue.push(fq)
        outboxUpsert({ idemKey: fq.idemKey!, text: fq.text, page: fq.page, attachmentIds: fq.attachmentIds, ts: Date.now() })
        setJob({ ...getState().job })
      })
      return
    }
    // One active job per site — later sends queue and auto-dispatch on finish.
    const queued: QueuedInput = { ...input, idemKey: input.idemKey || uuid() }
    queue.push(queued)
    outboxUpsert({
      idemKey: queued.idemKey!,
      text: queued.text,
      page: queued.page,
      attachmentIds: queued.attachmentIds,
      ts: Date.now(),
    })
    const j = getState().job
    if (j.phase === 'streaming' || j.phase === 'sending') setJob({ ...j }) // nudge subscribers to render the queue
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
  activeIdemKey = input.idemKey || uuid()
  activeThumbs = input.thumbs?.length ? input.thumbs : undefined
  activeFiles = input.files?.length ? input.files : undefined
  lastPage = input.page || location.pathname
  lastAttachmentIds = input.attachmentIds ?? []
  terminal = false
  attempt = 0
  pendingUserTexts = [input.text] // first turn; shifted off when its result lands (streaming only)
  setJob({ phase: 'sending', startedAt })

  // Persist the in-flight send BEFORE the POST: a reload in the POST→job-frame
  // window re-sends the same idemKey and the server re-tails the original job.
  outboxUpsert({
    idemKey: activeIdemKey,
    text: input.text,
    page: lastPage,
    attachmentIds: lastAttachmentIds.length ? lastAttachmentIds : undefined,
    ts: Date.now(),
    inFlight: true,
  })
  api
    .sendMessage(
      CONFIG.site,
      {
        text: input.text,
        page: lastPage,
        idemKey: activeIdemKey,
        attachmentIds: lastAttachmentIds.length ? lastAttachmentIds : undefined,
      },
      frameHandler(gen),
    )
    .then(() => {
      if (gen === generation && !terminal) onDisconnect(gen)
    })
    .catch((e: unknown) => {
      if (gen !== generation || terminal) return
      if (jobId) {
        onDisconnect(gen) // network blip after the job started → reconnect
      } else {
        // A 4xx is the server's final answer — the send is never going to work, so
        // drop it. Leaving it in the outbox meant a rejected message replayed (and
        // re-failed) on every single reload, forever. A 5xx or a network drop is
        // ambiguous: the POST may have landed, so that entry stays for recovery.
        const status = (e as { status?: number } | null)?.status
        if (typeof status === 'number' && status >= 400 && status < 500) outboxRemove(activeIdemKey)
        const message = errMsg(e)
        if (prompt || activeThumbs?.length || activeFiles?.length) {
          liveTurns.push({ role: 'user', text: prompt, thumbs: activeThumbs, files: activeFiles })
        }
        liveTurns.push({ role: 'error', text: message })
        clearPersist()
        reset()
        setJob({ phase: 'error', message })
        dispatchQueue()
      }
    })
}

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  // "/jobs/x/stream -> 502" is readSse's last-resort label when the server sent no
  // {error} of its own. It's plumbing, not an explanation — don't show it to anyone.
  if (!m || /^\/\S* -> \d+$/.test(m)) return 'Could not reach the server.'
  return m
}

/** Re-send any persisted outbox entries, oldest first. The in-flight entry (if
 *  any) goes back through start() with its original idemKey — the server
 *  re-tails the job if it started. If an active job re-attached first, the
 *  entries route into the client queue via start()'s busy path. */
function restoreOutbox(): void {
  const items = readOutbox()
  if (!items.length) return
  items.sort((a, b) => Number(!!b.inFlight) - Number(!!a.inFlight) || a.ts - b.ts)
  for (const it of items) {
    start({ text: it.text, attachmentIds: it.attachmentIds, page: it.page, idemKey: it.idemKey })
  }
}

/** Shared attach sequence for a known-running job (boot rehydrate + discovery). */
function attachToRunningJob(job: { jobId: string; startedAt: number; prompt: string }): void {
  bindWake()
  generation++
  const gen = generation
  jobId = job.jobId
  startedAt = job.startedAt || Date.now()
  prompt = job.prompt
  activeIdemKey = ''
  activeThumbs = undefined // never carry thumbs from a previous page's job
  activeFiles = undefined
  lastPage = location.pathname
  lastAttachmentIds = []
  terminal = false
  attempt = 0
  setJob({ phase: 'streaming', jobId: job.jobId, startedAt, line: 'reconnecting…', lineState: 'dim', fullText: '', disconnected: true })
  // Surface the re-attached job's pill on reload — but never override an explicit
  // view (expanded chat, or a corner the user deliberately minimized to).
  if (getState().ui.mode === 'mini') patchUi({ mode: 'collapsed' })
  persist()
  reattach(gen, true)
}

/** Attach to a running job this device doesn't know about (cleared storage,
 *  another device, a lost active-job key). Registry + a 10-min finished window
 *  come back from GET /jobs; the handled ledger filters out jobs this device
 *  already saw complete. No-ops unless idle. Errors are swallowed — discovery
 *  is best-effort. */
export async function discoverJobs(): Promise<void> {
  if (getState().job.phase !== 'idle') return
  if (!hasStoredSession()) return
  let jobs: Awaited<ReturnType<typeof api.listJobs>>['jobs']
  try {
    jobs = (await api.listJobs(CONFIG.site)).jobs || []
  } catch {
    return
  }
  if (getState().job.phase !== 'idle') return // a send raced the fetch
  const handled = readHandled()
  const running = jobs
    .filter((j) => j.status === 'running' && j.job_id && !handled.has(j.job_id))
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
  const row = running[0]
  if (!row) return
  // Note: if this device also holds an in-flight outbox entry for the SAME job
  // (job frame lost pre-persist, then reload), the entry re-queues and later
  // re-POSTs its idemKey — the server re-tails the finished job rather than
  // re-running it, and the transcript reconciles the duplicate. Redundant but
  // harmless; matching the entry to the discovered job isn't possible client-side.
  attachToRunningJob({
    jobId: row.job_id,
    startedAt: (row.created_at && Date.parse(row.created_at)) || Date.now(),
    prompt: '', // unknown here — finishDone skips the live turn; history renders it
  })
}

/** Boot policy: zero network unless there's evidence of prior activity — a
 *  persisted active job, a non-empty outbox, or a job started on this device
 *  that was never observed finishing (the last-job-at flag). */
export function bootRehydrate(): void {
  if (!hasStoredSession()) return
  const saved = readPersist()
  if (saved) {
    attachToRunningJob({ jobId: saved.jobId, startedAt: saved.startedAt, prompt: saved.prompt || '' })
    restoreOutbox()
    return
  }
  let lastJobAt = 0
  try {
    lastJobAt = Number(localStorage.getItem(lsKey('last-job-at')) || 0)
  } catch {
    /* ignore */
  }
  if (lastJobAt && Date.now() - lastJobAt < 30 * 60_000) {
    // Discovery must settle BEFORE the outbox restore: restore's start() would
    // see phase idle mid-fetch, fire as a fresh send, and make discovery bail —
    // losing the re-attach to the genuinely running job.
    void discoverJobs().finally(() => restoreOutbox())
  } else {
    restoreOutbox()
  }
}
