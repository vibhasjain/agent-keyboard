// visualViewport keyboard avoidance. On iOS the layout viewport doesn't shrink
// when the keyboard opens, so a fixed-bottom bar hides behind it. We track the
// gap and expose it as a --ak-kb CSS var on the host; styles lift the bar/footer.

let host: HTMLElement | null = null
let attached = 0

export function initViewport(hostEl: HTMLElement): void {
  host = hostEl
}

function measure(): void {
  const vv = window.visualViewport
  if (!vv || !host) return
  // Gap between the bottom of the visual viewport and the bottom of the layout viewport.
  const gap = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
  host.style.setProperty('--ak-kb', `${Math.round(gap)}px`)
}

function reset(): void {
  host?.style.setProperty('--ak-kb', '0px')
}

/** Call on focus of any composer input; returns a detach fn for blur. */
export function trackKeyboard(): () => void {
  const vv = window.visualViewport
  if (!vv) return () => {}
  attached++
  measure()
  vv.addEventListener('resize', measure)
  vv.addEventListener('scroll', measure)
  return () => {
    vv.removeEventListener('resize', measure)
    vv.removeEventListener('scroll', measure)
    attached = Math.max(0, attached - 1)
    if (attached === 0) reset()
  }
}
