// The status ticker: one line at a time. Two pieces:
//  1. makeFadeLine — tail-fade on overflow + hover glide.
//  2. the slide-up handoff engine (pushLine/setLine).
//
// State (colour) change ⇒ a new line slides up and takes over. Same state ⇒ the
// current line's text is replaced in place (no vertical motion).

import { el, prefersReducedMotion, raf, reflow } from './dom'
import type { LineState } from './state'

interface FadeLine {
  el: HTMLSpanElement
  setText: (t: string) => void
  dispose: () => void
}

/** Port of FadeText.tsx to vanilla: the element scrolls horizontally on overflow,
 *  a 3-position -webkit-mask fades the trailing edge, and hovering glides it. */
function makeFadeLine(): FadeLine {
  const span = el('span', 'ak-line')
  let overflowing = false
  let pos: 'start' | 'mid' | 'end' = 'start'
  let rafId: number | null = null

  const applyMask = () => {
    let mask = ''
    if (overflowing) {
      mask =
        pos === 'start'
          ? 'linear-gradient(to right, black calc(100% - 16px), transparent 100%)'
          : pos === 'end'
            ? 'linear-gradient(to right, transparent 0, black 16px)'
            : 'linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)'
    }
    span.style.webkitMaskImage = mask
    span.style.maskImage = mask
  }

  const check = () => {
    overflowing = span.scrollWidth > span.clientWidth + 1
    applyMask()
  }

  const onScroll = () => {
    const max = span.scrollWidth - span.clientWidth
    pos = span.scrollLeft <= 1 ? 'start' : span.scrollLeft >= max - 1 ? 'end' : 'mid'
    applyMask()
  }

  const stop = () => {
    if (rafId != null) cancelAnimationFrame(rafId)
    rafId = null
  }
  const glide = (target: number) => {
    if (prefersReducedMotion()) {
      span.scrollLeft = target
      return
    }
    stop()
    let last = performance.now()
    const step = (now: number) => {
      const dt = now - last
      last = now
      const cur = span.scrollLeft
      const next = cur < target ? Math.min(cur + 0.09 * dt, target) : Math.max(cur - 0.3 * dt, target)
      span.scrollLeft = next
      rafId = Math.abs(next - target) > 0.5 ? raf(step) : null
    }
    rafId = raf(step)
  }

  span.addEventListener('scroll', onScroll)
  span.addEventListener('mouseenter', () => {
    if (overflowing) glide(span.scrollWidth - span.clientWidth)
  })
  span.addEventListener('mouseleave', () => glide(0))

  const ro = new ResizeObserver(check)
  ro.observe(span)

  return {
    el: span,
    setText: (t: string) => {
      span.textContent = t
      check()
    },
    dispose: () => {
      stop()
      ro.disconnect()
    },
  }
}

export interface Ticker {
  set: (text: string, state: LineState) => void
  clear: () => void
}

// Filler for the gap before the agent's first real status line. A frozen "Working"
// for twenty seconds reads as stalled; a word that turns over reads as alive. Only
// ever used when there is nothing real to show — any detail from the server wins.
const THINKING_WORDS = ['Thinking', 'Pondering', 'Working', 'Cooking', 'Crunching', 'Percolating', 'Noodling', 'Conjuring']

export function thinkingWord(startedAt: number): string {
  if (prefersReducedMotion()) return THINKING_WORDS[0]
  return THINKING_WORDS[Math.floor(Math.max(0, Date.now() - startedAt) / 2000) % THINKING_WORDS.length]
}

const STATE_CLASSES: LineState[] = ['dim', 'thinking', 'tool', 'assistant']

export function makeTicker(container: HTMLElement): Ticker {
  let cur: FadeLine | null = null
  let curState: LineState | null = null
  let pushTok = 0

  const push = (state: LineState) => {
    if (cur) {
      const old = cur
      old.el.classList.remove('current')
      old.el.classList.add('exiting')
      const tok = ++pushTok
      setTimeout(() => {
        if (tok <= pushTok) {
          old.dispose()
          old.el.remove()
        }
      }, 800)
    }
    const line = makeFadeLine()
    line.el.classList.add('entering')
    STATE_CLASSES.forEach((c) => line.el.classList.remove(c))
    line.el.classList.add(state)
    container.appendChild(line.el)
    reflow(line.el)
    raf(() => {
      line.el.classList.remove('entering')
      line.el.classList.add('current')
    })
    cur = line
    curState = state
  }

  return {
    set: (text: string, state: LineState) => {
      if (!cur || curState !== state) push(state)
      cur!.setText(text)
    },
    clear: () => {
      pushTok++
      container.replaceChildren()
      if (cur) cur.dispose()
      cur = null
      curState = null
    },
  }
}
