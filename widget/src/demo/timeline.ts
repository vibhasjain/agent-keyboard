// The scene scheduler: a setTimeout chain that plays timed steps, loops, and —
// crucially for an embedded ambient demo — freezes whenever the iframe is hidden
// (tab switch) OR scrolled out of the parent's viewport. Frozen means "resume
// from the exact same offset", never "skip ahead", so a scene never jumps.

import { prefersReducedMotion } from '../dom'

export interface TimelineStep {
  at: number // ms from the start of each loop cycle
  run: () => void
}

export interface TimelineOpts {
  loopAt: number // cycle length; onReset fires here, then the cycle replays
  posterAt: number // reduced-motion cutoff: run steps up to here once, no loop
  onReset: () => void
}

export function runTimeline(steps: TimelineStep[], opts: TimelineOpts): void {
  const sorted = [...steps].sort((a, b) => a.at - b.at)

  // Reduced motion: paint one representative "poster" frame and stop. No loop,
  // no per-char animation (the action helpers go instant under the same query).
  if (prefersReducedMotion()) {
    for (const s of sorted) if (s.at <= opts.posterAt) s.run()
    return
  }

  let idx = 0
  let offset = 0 // cycle-time consumed so far (frozen across pauses)
  let anchor = 0 // performance.now() at the last resume
  let timer: ReturnType<typeof setTimeout> | null = null
  let paused = true

  const clearTimer = (): void => {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const schedule = (): void => {
    clearTimer()
    if (paused) return
    if (idx >= sorted.length) {
      // Tail of the cycle: wait out the remainder, reset, replay from zero.
      timer = setTimeout(() => {
        opts.onReset()
        idx = 0
        offset = 0
        anchor = performance.now()
        schedule()
      }, Math.max(0, opts.loopAt - offset))
      return
    }
    const next = sorted[idx]
    timer = setTimeout(() => {
      offset = next.at // snap to this step's cycle-time (we waited exactly to it)
      anchor = performance.now()
      next.run()
      idx++
      schedule()
    }, Math.max(0, next.at - offset))
  }

  const resume = (): void => {
    if (!paused) return
    paused = false
    anchor = performance.now()
    schedule()
  }
  const pause = (): void => {
    if (paused) return
    offset += performance.now() - anchor // bank the real time elapsed this run
    paused = true
    clearTimer()
  }

  let onscreen = false
  const sync = (): void => {
    if (!document.hidden && onscreen) resume()
    else pause()
  }

  // IntersectionObserver on the document element reports iframe viewability even
  // cross-origin — the one signal that survives being embedded on the marketing
  // site. visibilitychange covers tab/window switches.
  try {
    const io = new IntersectionObserver(
      (entries) => {
        onscreen = entries.some((e) => e.isIntersecting)
        sync()
      },
      { threshold: 0 },
    )
    io.observe(document.documentElement)
  } catch {
    onscreen = true // no IO support: fall back to visibility only
    sync()
  }
  document.addEventListener('visibilitychange', sync)
}
