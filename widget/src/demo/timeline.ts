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

  // Play only when actually on screen: a hidden tab (visibilitychange) OR the
  // iframe scrolled out of the parent's viewport. The parent can't be observed
  // from inside a cross-origin iframe, so the embedding page watches the frame
  // with an IntersectionObserver and posts {type:'ak-demo-vis', visible} here.
  // Default visible=true so an older embedder that never posts still plays (no
  // regression) — the message only ever PAUSES an off-screen frame. Freezing
  // banks the offset, so a scene resumes exactly where it left off, never jumps.
  // This matters most on mobile, where a forever-looping off-screen demo would
  // otherwise burn the main thread and make scrolling janky.
  let inView = true
  const sync = (): void => {
    if (!document.hidden && inView) resume()
    else pause()
  }
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent || !e.data || e.data.type !== 'ak-demo-vis') return
    inView = !!e.data.visible
    sync()
  })
  document.addEventListener('visibilitychange', sync)
  sync()
}
