// The expand scene: open the full transcript over a seeded history (a photo
// turn, a tool-using assistant reply, a compaction divider), then stream one
// live turn end-to-end before collapsing back to the done pill.

import { getLiveTurns, type LiveTurn, start } from '../../jobstore'
import { patchUi, setJob } from '../../state'
import type { ConversationMessage } from '../../api'
import type { Frame } from '../fake-api'
import { type Scene, streamFrames } from './scene'

const history: ConversationMessage[] = [
  { id: 'e1', role: 'user', text: 'add a contact section with an email link', photos: 2 },
  {
    id: 'e2',
    role: 'assistant',
    text: 'Added a **Contact** block under the gallery:\n\n- a mailto link to hello@sundaypottery.com\n- matched to the existing type scale\n\nPushed to `main`.',
    tools: ['read a file', 'edited a file'],
  },
  { id: 'e3', role: 'system', kind: 'compact', text: 'session compacted' },
]

const send: Frame[] = [
  [150, 'job', { job_id: 'demo-expand' }],
  [500, 'status', { phase: 'thinking', detail: 'Reading the nav' }],
  [1600, 'status', { phase: 'tool', detail: 'Editing index.html' }],
  ...streamFrames('Tightened the nav spacing — 12px between links now.', 2600, 4200),
  [4600, 'result', { reply: 'Done — tightened the nav spacing.', git: { changed: true, pushed: true, headSha: '7c2f0aa00', branch: 'main' } }],
]

export const expand: Scene = {
  script: { send, conversation: { messages: history, cursor: null } },
  build: ({ minisite }) => ({
    loopAt: 13000,
    posterAt: 5000,
    steps: [
      // Resting done pill (as if a change just shipped), then open the transcript.
      { at: 0, run: () => setJob({ phase: 'done', jobId: 'demo-seed', summary: 'pushed 7c2f0aa — refresh to see it', ok: true }) },
      { at: 1200, run: () => patchUi({ mode: 'expanded' }) },
      { at: 3000, run: () => start({ text: 'tighten the nav spacing', page: '/' }) },
      { at: 10500, run: () => patchUi({ mode: 'collapsed' }) },
    ],
    onReset: () => {
      patchUi({ mode: 'collapsed' })
      setJob({ phase: 'idle' })
      // liveTurns is a jobstore singleton with no clear() — empty the live
      // reference so the looping transcript doesn't stack identical turns.
      ;(getLiveTurns() as LiveTurn[]).length = 0
      minisite.reset()
    },
  }),
}
