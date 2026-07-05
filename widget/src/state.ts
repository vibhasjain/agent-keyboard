// The single source of truth: a tiny pub/sub store with three orthogonal slices
// (auth · job · ui). Components read the current slice and re-render on notify.

export type AuthState = 'unknown' | 'anon' | 'authed'

// The line's visual state maps 1:1 to a ticker colour. 'dim' covers the neutral
// syncing/queued/retrying phases; 'assistant' is the streamed reply tail.
export type LineState = 'dim' | 'thinking' | 'tool' | 'assistant'

export type JobState =
  | { phase: 'idle' }
  | { phase: 'sending'; startedAt: number }
  | {
      phase: 'streaming'
      jobId: string
      startedAt: number
      line: string
      lineState: LineState
      fullText: string
      disconnected?: boolean
    }
  | { phase: 'done'; jobId: string; summary: string; ok: boolean; cleared?: boolean }
  | { phase: 'error'; message: string; retry?: () => void }

export type UiMode = 'mini' | 'collapsed' | 'login' | 'setpw' | 'composing' | 'expanded'
export type VoiceState = 'idle' | 'connecting' | 'live' | 'error'

export interface UiState {
  mode: UiMode
  voice: VoiceState
  voiceError?: string
  loginError?: boolean
  composerNote?: string // transient hint under the composer (e.g. "still working…")
  signingOut?: string // set (to the pill message) during the log-out → reload sequence
}

export interface State {
  auth: AuthState
  job: JobState
  ui: UiState
}

const state: State = {
  auth: 'unknown',
  job: { phase: 'idle' },
  ui: { mode: 'mini', voice: 'idle' },
}

const listeners = new Set<() => void>()

export function getState(): Readonly<State> {
  return state
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(): void {
  for (const l of [...listeners]) l()
}

export function setAuth(auth: AuthState): void {
  if (state.auth === auth) return
  state.auth = auth
  emit()
}

export function setJob(job: JobState): void {
  state.job = job
  emit()
}

export function patchUi(patch: Partial<UiState>): void {
  state.ui = { ...state.ui, ...patch }
  emit()
}
