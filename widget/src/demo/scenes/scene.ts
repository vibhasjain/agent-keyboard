// Shared scene contract. A scene has two halves that run at different times:
//  · script — installed BEFORE the bar mounts (installFakeApi needs the frames)
//  · build(ctx) — called AFTER mount, returns the timeline that drives the DOM

import type { Frame, SceneScript } from '../fake-api'
import type { Minisite } from '../minisite'
import type { TimelineStep } from '../timeline'

export interface SceneCtx {
  shadow: ShadowRoot
  minisite: Minisite
}

export interface SceneTimeline {
  steps: TimelineStep[]
  loopAt: number
  posterAt: number
  onReset: () => void
}

export interface Scene {
  script: SceneScript
  build: (ctx: SceneCtx) => SceneTimeline
}

/** Accumulating assistant tokens between two offsets (full-text-per-frame, the
 *  shape jobstore expects). Whitespace is preserved so the reply reads naturally. */
export function streamFrames(text: string, from: number, to: number, event = 'assistant'): Frame[] {
  const tokens = text.split(/(\s+)/).filter(Boolean)
  const frames: Frame[] = []
  let acc = ''
  tokens.forEach((tok, i) => {
    acc += tok
    const at = Math.round(from + ((to - from) * (i + 1)) / tokens.length)
    frames.push([at, event, { text: acc }])
  })
  return frames
}
