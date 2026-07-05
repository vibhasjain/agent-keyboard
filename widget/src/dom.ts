// Minimal DOM helpers — no framework, no runtime deps.

type Tag = keyof HTMLElementTagNameMap

/** Create an element with an optional class and an imperative initializer. */
export function el<K extends Tag>(
  tag: K,
  cls?: string,
  init?: (n: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  init?.(n)
  return n
}

/** Set text content and return the node (chainable). */
export function txt<T extends HTMLElement>(n: T, s: string): T {
  n.textContent = s
  return n
}

export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | Window | Document,
  type: K | string,
  handler: (ev: Event) => void,
  opts?: AddEventListenerOptions | boolean,
): () => void {
  target.addEventListener(type, handler as EventListener, opts)
  return () => target.removeEventListener(type, handler as EventListener, opts)
}

export function show(n: HTMLElement, visible: boolean): void {
  n.style.display = visible ? '' : 'none'
}

export function clear(n: HTMLElement): void {
  while (n.firstChild) n.removeChild(n.firstChild)
}

// Inline stroke icons (lucide-style, currentColor) — emoji render with
// platform-dependent glyph metrics and broke the bar's vertical rhythm.
const ICON_PATHS: Record<string, string> = {
  camera:
    '<path d="M14.5 4h-5L7.4 6.4 4 7v13h16V7l-3.4-.6L14.5 4z" fill="none"/><circle cx="12" cy="13" r="3.4" fill="none"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3" fill="none"/><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5V21" fill="none"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" stroke="none" fill="currentColor"/>',
  'arrow-up': '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" fill="none"/>',
  'arrow-right': '<path d="M5 12h14M12.5 5.5 19 12l-6.5 6.5" fill="none"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" fill="none"/>',
  'chevron-down': '<path d="M5 9.5 12 16l7-6.5" fill="none"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="none"/>',
  check: '<path d="M4.5 12.5 10 18 19.5 6.5" fill="none"/>',
  retry: '<path d="M20 12a8 8 0 1 1-2.5-5.8M20 3v4.5h-4.5" fill="none"/>',
  x: '<path d="M6 6l12 12M18 6 6 18" fill="none"/>',
  settings:
    '<path d="M4 8h16M4 16h16" fill="none"/><circle cx="9" cy="8" r="2.4" fill="none"/><circle cx="15" cy="16" r="2.4" fill="none"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" fill="none"/>',
}

/** Inline SVG icon sized to 1em-ish; color follows currentColor. */
export function icon(name: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = ICON_PATHS[name] ?? ''
  return svg
}

export const raf = (fn: FrameRequestCallback): number => requestAnimationFrame(fn)

/** Force a style/layout flush so the next class change animates. */
export function reflow(n: HTMLElement): void {
  void n.offsetWidth
}

export function uuid(): string {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID()
  } catch {
    /* not available */
  }
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export const prefersReducedMotion = (): boolean => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
