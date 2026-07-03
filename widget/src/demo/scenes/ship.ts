// The headline scene: type a change, watch the job stream through sync →
// thinking → edit → commit → reply, the deploy chip go live, and the real
// headline grow. The full ask → edit → ship loop in one shot.

import { start } from '../../jobstore'
import { patchUi, setJob } from '../../state'
import { clearTextarea, q, typeInto } from '../actions'
import type { Frame } from '../fake-api'
import { type Scene, streamFrames } from './scene'

const PROMPT = 'make the headline bigger on phones'

const send: Frame[] = [
  [200, 'job', { job_id: 'demo-ship' }],
  [400, 'status', { phase: 'queued', detail: 'Queued' }],
  [1200, 'status', { phase: 'syncing', detail: 'Syncing the repo' }],
  [2500, 'status', { phase: 'thinking', detail: 'Reading the current layout…' }],
  [4500, 'status', { phase: 'tool', detail: 'Editing index.html' }],
  [6500, 'status', { phase: 'tool', detail: '$ git commit -am "Hero: larger phone headline"' }],
  ...streamFrames('Done — bumped the phone headline so it reads larger on small screens.', 8000, 10800),
  [
    11200,
    'result',
    { reply: 'Done — bumped the phone headline.', git: { changed: true, pushed: true, headSha: '3f2a91c00', branch: 'main' } },
  ],
]

export const ship: Scene = {
  script: { send },
  build: ({ shadow, minisite }) => {
    const ta = q<HTMLTextAreaElement>(shadow, '.ak-ta')
    return {
      loopAt: 22000,
      posterAt: 18000,
      steps: [
        { at: 500, run: () => typeInto(ta, PROMPT, 12) },
        {
          at: 3800,
          run: () => {
            start({ text: ta.value.trim() || PROMPT, page: '/' })
            clearTextarea(ta)
            patchUi({ mode: 'collapsed' })
          },
        },
        { at: 15000, run: () => minisite.deploy.deploying() },
        {
          at: 17500,
          run: () => {
            minisite.deploy.live()
            minisite.growHeadline(true)
          },
        },
        { at: 20500, run: () => setJob({ phase: 'idle' }) },
      ],
      onReset: () => {
        clearTextarea(ta)
        setJob({ phase: 'idle' })
        patchUi({ mode: 'collapsed' })
        minisite.reset()
      },
    }
  },
}
