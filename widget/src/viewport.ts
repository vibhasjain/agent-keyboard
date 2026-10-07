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
  // Gap between the bottom of the visual viewport and the bottom of the panel
  // we lift (100dvh). Measured against the panel itself, not innerHeight: iOS
  // (notably home-screen apps) can shrink innerHeight with the keyboard while the
  // panel stays full height, which read as no gap and left the composer hidden.
  const panel = host.shadowRoot?.querySelector('.ak-overlay')?.getBoundingClientRect()
  const bottom = Math.max(window.innerHeight, panel?.height ? panel.bottom : 0)
  const gap = Math.max(0, bottom - (vv.height + vv.offsetTop))
  host.style.setProperty('--ak-kb', `${Math.round(gap)}px`)
  // How far the visual viewport has scrolled down inside the layout viewport
  // (iOS scrolls it when the keyboard opens). Anything pinned to the VISIBLE
  // top — the chat's collapse button — offsets by this.
  host.style.setProperty('--ak-vvt', `${Math.round(Math.max(0, vv.offsetTop))}px`)
}

function reset(): void {
  host?.style.setProperty('--ak-kb', '0px')
  host?.style.setProperty('--ak-vvt', '0px')
  host?.classList.remove('ak-kbd')
}

/** Call on focus of any composer input; returns a detach fn for blur. */
export function trackKeyboard(): () => void {
  const vv = window.visualViewport
  if (!vv) return () => {}
  attached++
  host?.classList.add('ak-kbd')
  measure()
  // iOS can finish the keyboard animation without a final resize event.
  for (const ms of [150, 400, 800]) setTimeout(() => attached && measure(), ms)
  vv.addEventListener('resize', measure)
  vv.addEventListener('scroll', measure)
  return () => {
    vv.removeEventListener('resize', measure)
    vv.removeEventListener('scroll', measure)
    attached = Math.max(0, attached - 1)
    if (attached === 0) reset()
  }
}
