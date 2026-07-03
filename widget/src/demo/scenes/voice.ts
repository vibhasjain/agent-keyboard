// The voice scene: mic goes live, dictation streams in as word-bursts that grow
// the composer past its height cap and keep the newest words pinned in view.
// No send — this beat is only about hold-to-talk.

import { clearTextarea, dictateInto, micLive, q } from '../actions'
import type { Scene } from './scene'

const BURSTS = [
  'make the gallery photos bigger',
  ' and give them more room',
  ' on phones',
  ' maybe twenty percent',
  ' and a touch more spacing between them',
]

export const voice: Scene = {
  script: {},
  build: ({ shadow, minisite }) => {
    const ta = q<HTMLTextAreaElement>(shadow, '.ak-ta')
    return {
      loopAt: 10000,
      posterAt: 4500,
      steps: [
        { at: 300, run: () => micLive(shadow, true) },
        { at: 800, run: () => dictateInto(ta, BURSTS, 1200) },
        { at: 7200, run: () => micLive(shadow, false) },
      ],
      onReset: () => {
        clearTextarea(ta)
        micLive(shadow, false)
        minisite.reset()
      },
    }
  },
}
