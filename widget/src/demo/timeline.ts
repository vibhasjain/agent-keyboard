// The scene scheduler: a setTimeout chain that plays timed steps, loops, and —
// crucially for an embedded ambient demo — freezes whenever the iframe is hidden
// (tab switch) OR scrolled out of the parent's viewport. Frozen means "resume
// from the exact same offset", never "skip ahead", so a scene never jumps.

import { prefersReducedMotion } from '../dom'
import { getState, setJob } from '../state'

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
    // The real jobstore lingers the done pill ~8s then blanks it — fine in a
    // loop, but a poster must STAY the payoff, not decay to an empty bar
    // (observed on iOS with Reduce Motion on). Re-pin the job state once,
    // after the linger has fired.
    const snap = getState().job
    if (snap.phase === 'done') {
      setTimeout(() => {
        if (getState().job.phase !== 'done') setJob(snap)
      }, 9500)
    }
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

  // Default to RUNNING. Cross-origin iframe viewability via IntersectionObserver
  // is not reliable everywhere (iOS Safari can simply never report intersecting,
  // which used to freeze every scene on mobile) — so the observer is a pure
  // optimization: it may only pause the loop once it has PROVEN it works by
  // reporting at least one intersecting entry. visibilitychange covers tab and
  // window switches on its own.
  let onscreen = true
  let ioTrusted = false
  const sync = (): void => {
    if (!document.hidden && onscreen) resume()
    else pause()
  }
  try {
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((e) => e.isIntersecting)
        if (hit) ioTrusted = true
        if (ioTrusted) {
          onscreen = hit
          sync()
        }
      },
      { threshold: 0 },
    )
    io.observe(document.documentElement)
  } catch {
    /* no IO: visibility-only */
  }
  document.addEventListener('visibilitychange', sync)
  sync()
}
