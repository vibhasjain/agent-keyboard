// The splash story, in the owner's words: you're ON a website (established
// first, readable) — a prompt goes in — thinking, thinking — pushed — the page
// REFRESHES — and the change you see is exactly what the prompt asked for.
// Predetermined pair: "make the headline bigger" → the headline is bigger.

import { start } from '../../jobstore'
import { patchUi, setJob } from '../../state'
import { clearTextarea, q, typeInto } from '../actions'
import type { Frame } from '../fake-api'
import { type Scene, streamFrames } from './scene'

const PROMPT = 'make the headline bigger on phones'

const send: Frame[] = [
  [200, 'job', { job_id: 'demo-ship' }],
  [400, 'status', { phase: 'queued', detail: 'Queued' }],
  [1000, 'status', { phase: 'syncing', detail: 'Syncing the repo' }],
  [2000, 'status', { phase: 'thinking', detail: 'Reading the current layout…' }],
  [3600, 'status', { phase: 'tool', detail: 'Editing index.html' }],
  [5200, 'status', { phase: 'tool', detail: '$ git commit -am "Hero: larger phone headline"' }],
  ...streamFrames('Done — bumped the phone headline so it reads larger on small screens.', 6400, 8200),
  [
    8700,
    'result',
    { reply: 'Done — bumped the phone headline.', git: { changed: true, pushed: true, headSha: '3f2a91c00', branch: 'main' } },
  ],
]

export const ship: Scene = {
  script: { send },
  build: ({ shadow, minisite }) => {
    const ta = q<HTMLTextAreaElement>(shadow, '.ak-ta')
    return {
      loopAt: 20200,
      posterAt: 17600,
      steps: [
        // 0–2.2s: establish — you are on a website; nothing else happens.
        {
          at: 2200,
          run: () => {
            minisite.dim() // the page recedes; the bar becomes the subject
            typeInto(ta, PROMPT, 12)
          },
        },
        {
          at: 5600,
          run: () => {
            start({ text: ta.value.trim() || PROMPT, page: '/' })
            clearTextarea(ta)
            patchUi({ mode: 'collapsed' })
          },
        },
        // job runs 5.6s → ~14.3s (queued → syncing → thinking → edit → commit → reply → pushed)
        {
          at: 15600,
          run: () => minisite.refresh(() => minisite.growHeadline(true)), // the refresh beat: blank → the changed page
        },
        { at: 19400, run: () => setJob({ phase: 'idle' }) },
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
