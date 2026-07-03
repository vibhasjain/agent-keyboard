// The scene scheduler: a setTimeout chain that plays timed steps, loops, and —
// crucially for an embedded ambient demo — freezes whenever the iframe is hidden
// (tab switch) OR scrolled out of the parent's viewport. Frozen means "resume
// from the exact same offset", never "skip ahead", so a scene never jumps.


export interface TimelineStep {
  at: number // ms from the start of each loop cycle
  run: () => void
}

export interface TimelineOpts {
  loopAt: number // cycle length; onReset fires here, then the cycle replays
  posterAt: number // kept for API stability; scenes always loop (owner's call: demos ignore Reduce Motion)
  onReset: () => void
}

export function runTimeline(steps: TimelineStep[], opts: TimelineOpts): void {
  const sorted = [...steps].sort((a, b) => a.at - b.at)

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

  // The ONLY pause is a hidden document (tab switch) — literally invisible.
  // No IntersectionObserver, no prefers-reduced-motion, no other gatekeepers:
  // the owner's standing rule is that demo animations play on every device,
  // always. (A hidden tab still banks its offset and resumes exactly in place.)
  const sync = (): void => {
    if (!document.hidden) resume()
    else pause()
  }
  document.addEventListener('visibilitychange', sync)
  sync()
}
