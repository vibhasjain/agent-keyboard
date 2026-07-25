// Generic signed-out product-tour runner. The actual adventure script lives on
// the host site and is fetched only when its embed opts into data-guest-demo.
// No auth, uploads, voice, privileged API routes, or coding agent are involved.

import type { ConversationMessage } from './api'
import { CONFIG } from './config'
import { getState, setJob, type LineState, type TodoItem } from './state'

interface DemoStage {
  at: number
  line: string
  state: LineState
  todo?: number
  subagent?: string
  disconnected?: boolean
}

interface DemoTurn {
  prompt: string
  reply: string
  options: string[]
  stages?: DemoStage[]
  attachments?: number
  thumbs?: string[]
  files?: string[]
  images?: string[]
  divider?: string
}

interface DemoScript {
  intro: string
  startOptions: string[]
  turns: Record<string, DemoTurn>
}

let script: DemoScript | null = null
let messages: ConversationMessage[] = []
let revision = 0
let running = false
let generation = 0
let nextId = 0
let loadPromise: Promise<void> | null = null
const listeners = new Set<() => void>()

const id = (): string => `guest-demo-${++nextId}`
const optionBlock = (items: string[]): string => `\n\n\`\`\`options\n${items.join('\n')}\n\`\`\``
const withOptions = (text: string, items: string[]): string => text + optionBlock(items)
const emit = (): void => {
  revision++
  for (const fn of [...listeners]) fn()
}

function firstMessage(): ConversationMessage {
  if (script) return { id: id(), role: 'assistant', text: withOptions(script.intro, script.startOptions) }
  return { id: id(), role: 'assistant', text: 'Loading the scripted tour...' }
}

function ensureMessages(): void {
  if (!messages.length) messages = [firstMessage()]
}

function validScript(value: unknown): value is DemoScript {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<DemoScript>
  return typeof v.intro === 'string' && Array.isArray(v.startOptions) && !!v.turns && typeof v.turns === 'object'
}

export function isGuestDemo(): boolean {
  return CONFIG.guestDemo && getState().auth !== 'authed'
}

export function loadGuestDemo(): Promise<void> {
  if (loadPromise) return loadPromise
  loadPromise = fetch(CONFIG.guestDemoUrl, { credentials: 'omit' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`tour -> ${res.status}`)
      const value: unknown = await res.json()
      if (!validScript(value)) throw new Error('invalid tour script')
      script = value
      messages = [firstMessage()]
      emit()
    })
    .catch(() => {
      messages = [
        {
          id: id(),
          role: 'assistant',
          text: 'The scripted tour could not load. Open the top-left menu to sign in as the owner, or refresh to try the tour again.',
        },
      ]
      emit()
    })
  return loadPromise
}

export function getGuestDemoMessages(): readonly ConversationMessage[] {
  ensureMessages()
  return messages
}

export function getGuestDemoRevision(): number {
  return revision
}

export function subscribeGuestDemo(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function resetGuestDemo(): void {
  generation++
  running = false
  messages = [firstMessage()]
  setJob({ phase: 'idle' })
  emit()
}

function backToStart(): void {
  if (!script) return
  messages.push(
    { id: id(), role: 'user', text: 'Show me something else.' },
    { id: id(), role: 'assistant', text: withOptions('Sure. Pick another part of Agent Keyboard to try.', script.startOptions) },
  )
  emit()
}

function todos(step: number | undefined): TodoItem[] | undefined {
  if (step == null) return undefined
  return [
    { content: 'Read the current app', status: step > 0 ? 'completed' : 'in_progress' },
    { content: 'Make the requested change', status: step > 1 ? 'completed' : step === 1 ? 'in_progress' : 'pending' },
    { content: 'Verify and push', status: step > 2 ? 'completed' : step === 2 ? 'in_progress' : 'pending' },
  ]
}

function showStage(startedAt: number, stage: DemoStage): void {
  setJob({
    phase: 'streaming',
    jobId: 'guest-demo',
    startedAt,
    line: stage.line,
    lineState: stage.state,
    fullText: '',
    todos: todos(stage.todo),
    subagents: stage.subagent ? [{ id: 'guest-demo-agent', desc: stage.subagent, startedAt: Date.now() }] : undefined,
    disconnected: stage.disconnected,
  })
}

export function chooseGuestDemo(label: string): void {
  if (!isGuestDemo() || !script || running) return
  if (label === 'Back to the start') {
    backToStart()
    return
  }
  const turn = script.turns[label]
  if (!turn) return

  running = true
  const run = ++generation
  const startedAt = Date.now()
  // The tour shows a natural prompt where a real user would have typed one, so the
  // user turn does NOT carry the label that was tapped. Record it on the message
  // that offered the choice, or the transcript can't tell which chip won.
  const asked = [...messages].reverse().find((m) => m.role === 'assistant')
  if (asked) asked.chosenOption = label
  messages.push({
    id: id(),
    role: 'user',
    text: turn.prompt,
    attachments: turn.attachments,
    thumbs: turn.thumbs,
    files: turn.files,
  })
  emit()

  const stages = turn.stages?.length ? turn.stages : [{ at: 180, line: 'Thinking', state: 'thinking' as const }]
  showStage(startedAt, stages[0])
  for (const stage of stages.slice(1)) {
    setTimeout(() => {
      if (generation === run) showStage(startedAt, stage)
    }, stage.at)
  }

  const doneAt = Math.max(...stages.map((stage) => stage.at), 600) + 700
  setTimeout(() => {
    if (generation !== run) return
    messages.push({ id: id(), role: 'assistant', text: withOptions(turn.reply, turn.options), images: turn.images })
    if (turn.divider) messages.push({ id: id(), role: 'system', kind: 'compact', text: turn.divider })
    if (messages.length > 32) messages = [messages[0], ...messages.slice(-24)]
    running = false
    setJob({ phase: 'idle' })
    emit()
  }, doneAt)
}
