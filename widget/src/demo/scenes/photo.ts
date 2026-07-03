// The photo scene: attach an image, watch it upload (real downscale + progress
// ring), ask for a change "like this", and ship it. Shorter beat than ship —
// the point is the attachment pipeline.

import { start } from '../../jobstore'
import { patchUi, setJob } from '../../state'
import { attachDemoPhoto, clearPhotos, clearTextarea, q, typeInto } from '../actions'
import type { Frame } from '../fake-api'
import { type Scene, streamFrames } from './scene'

const PROMPT = 'make the hero look like this'

const send: Frame[] = [
  [150, 'job', { job_id: 'demo-photo' }],
  [400, 'status', { phase: 'syncing', detail: 'Syncing the repo' }],
  [1200, 'status', { phase: 'thinking', detail: 'Looking at your photo…' }],
  [2000, 'status', { phase: 'tool', detail: 'Restyling the hero' }],
  ...streamFrames('Matched the hero to your photo — warmer tone, bigger type.', 2400, 3000),
  [
    3100,
    'result',
    { reply: 'Done — restyled the hero to match your photo.', git: { changed: true, pushed: true, headSha: 'b7e4d21aa', branch: 'main' } },
  ],
]

export const photo: Scene = {
  script: {
    send,
    upload: { durationMs: 2200, result: { id: 'up_demo', path: 'uploads/up_demo.jpg' } },
  },
  build: ({ shadow, minisite }) => {
    const ta = q<HTMLTextAreaElement>(shadow, '.ak-ta')
    return {
      loopAt: 12000,
      posterAt: 2200,
      steps: [
        { at: 600, run: () => attachDemoPhoto(shadow) },
        { at: 4200, run: () => typeInto(ta, PROMPT, 16) },
        {
          at: 6400,
          run: () => {
            clearPhotos(shadow)
            start({ text: ta.value.trim() || PROMPT, page: '/' })
            clearTextarea(ta)
            patchUi({ mode: 'collapsed' })
          },
        },
      ],
      onReset: () => {
        clearPhotos(shadow)
        clearTextarea(ta)
        setJob({ phase: 'idle' })
        patchUi({ mode: 'collapsed' })
        minisite.reset()
      },
    }
  },
}
