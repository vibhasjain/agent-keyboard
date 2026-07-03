// Scene actions: drive the REAL widget DOM the way a user would — type into the
// live textarea, append dictation bursts, attach a painted photo, toggle the mic.
// Every mutation goes through real DOM events so the widget's own handlers fire.

import { prefersReducedMotion } from '../dom'

/** Query one element inside the widget shadow; throw loudly if a scene selector
 *  drifts from the production markup (the demo is worthless if it silently no-ops). */
export function q<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const n = root.querySelector(sel) as T | null
  if (!n) throw new Error(`[ak-demo] selector not found: "${sel}" — widget markup changed?`)
  return n
}

const fireInput = (ta: HTMLTextAreaElement): void => {
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Type a string into a textarea char-by-char at ~cps chars/sec (instant under
 *  reduced motion). Dispatches a real 'input' after each char so autogrow +
 *  send-enable + draft-save all run exactly as they do for a human. */
export function typeInto(ta: HTMLTextAreaElement, text: string, cps = 26): void {
  if (prefersReducedMotion()) {
    ta.value = text
    fireInput(ta)
    return
  }
  const step = 1000 / cps
  let i = 0
  const tick = (): void => {
    ta.value = text.slice(0, ++i)
    fireInput(ta)
    if (i < text.length) setTimeout(tick, step)
  }
  setTimeout(tick, step)
}

/** Type into any input (email / password) char-by-char; password fields mask
 *  the real characters themselves. */
export function typeInput(input: HTMLInputElement, text: string, cps = 22): void {
  if (prefersReducedMotion()) {
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  const step = 1000 / cps
  let i = 0
  const tick = (): void => {
    input.value = text.slice(0, ++i)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    if (i < text.length) setTimeout(tick, step)
  }
  setTimeout(tick, step)
}

/** Append dictation as word-bursts, keeping the last spoken words in view — the
 *  same growth pattern voice.ts drives, long enough to pass the 88px height cap. */
export function dictateInto(ta: HTMLTextAreaElement, bursts: string[], gapMs = 1100): void {
  const append = (chunk: string): void => {
    ta.value = ta.value + chunk
    fireInput(ta)
    ta.scrollTop = ta.scrollHeight // pin to the newest words past the cap
  }
  if (prefersReducedMotion()) {
    append(bursts.join(''))
    return
  }
  bursts.forEach((b, i) => setTimeout(() => append(b), i * gapMs))
}

/** Clear a textarea through a real input event (mirrors the composer reset). */
export function clearTextarea(ta: HTMLTextAreaElement): void {
  ta.value = ''
  fireInput(ta)
}

// A little brand-flavoured "photo": an amber gradient hero block on near-black,
// with a couple of skeleton bars — reads as a snapshot, not a solid swatch.
function paintPhoto(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 240
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#0a0a0a'
    ctx.fillRect(0, 0, 320, 240)
    const g = ctx.createLinearGradient(0, 0, 320, 200)
    g.addColorStop(0, '#fff5e2')
    g.addColorStop(0.38, '#ffb86b')
    g.addColorStop(0.95, '#c4651a')
    ctx.fillStyle = g
    ctx.fillRect(24, 24, 272, 132)
    ctx.fillStyle = 'rgba(245,241,234,0.85)'
    ctx.fillRect(24, 176, 176, 16)
    ctx.fillStyle = 'rgba(111,106,97,0.7)'
    ctx.fillRect(24, 204, 232, 12)
  }
  return c
}

/** Paint a fake photo, wrap it as a File, and hand it to the real file input so
 *  the widget's downscale → upload → chip pipeline runs for real. */
export function attachDemoPhoto(root: ParentNode): void {
  const input = q<HTMLInputElement>(root, '.ak-file')
  paintPhoto().toBlob((blob) => {
    if (!blob) return
    const file = new File([blob], 'inspiration.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, 'image/png')
}

/** Remove any staged photo chips the way a user would (clicking each chip's ×). */
export function clearPhotos(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>('.ak-chip-x').forEach((x) => x.click())
}

/** Toggle the mic's live pulse (voice.ts sets this class via its state machine;
 *  the demo drives the visual directly since there is no real WebRTC session). */
export function micLive(root: ParentNode, on: boolean): void {
  const mic = q(root, '.ak-mic')
  mic.classList.toggle('live', on)
}
