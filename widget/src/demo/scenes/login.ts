// The login scene: the composer flips to the Claude Code-style prompt sequence,
// the "> " mark tracks focus down from email to password (real chars, masked by
// the field), then resolves into the composer as a signed-in session would.

import { patchUi } from '../../state'
import { q, typeInput } from '../actions'
import type { Scene } from './scene'

export const login: Scene = {
  script: {},
  build: ({ shadow, minisite }) => {
    const email = q<HTMLInputElement>(shadow, '.ak-login input[type="email"]')
    const pw = q<HTMLInputElement>(shadow, '.ak-login input[type="password"]')
    const rows = Array.from(shadow.querySelectorAll<HTMLElement>('.ak-lg-row'))
    const focusRow = (i: number): void => rows.forEach((r, j) => r.classList.toggle('demo-focus', i === j))

    return {
      loopAt: 10000,
      posterAt: 4000,
      steps: [
        {
          at: 600,
          run: () => {
            patchUi({ mode: 'login' })
            focusRow(0)
          },
        },
        { at: 1200, run: () => typeInput(email, 'you@example.com', 18) },
        { at: 3800, run: () => focusRow(1) },
        { at: 4200, run: () => typeInput(pw, 'clay-studio-42', 16) },
        { at: 6800, run: () => patchUi({ mode: 'composing' }) },
      ],
      onReset: () => {
        email.value = ''
        pw.value = ''
        focusRow(-1)
        patchUi({ mode: 'collapsed' })
        minisite.reset()
      },
    }
  },
}
