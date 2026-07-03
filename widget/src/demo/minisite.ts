// The fake site behind the bar (light DOM). A real serif headline that visibly
// grows, skeleton body bars, and a deploy chip that goes deploying → live. Its
// stylesheet is injected once into document.head.

import { el } from '../dom'
import { MINISITE_STYLES } from './styles'

export interface Minisite {
  /** establish → backdrop: the page recedes while the widget works */
  dim: () => void
  /** the refresh beat: fade to blank, apply the change mid-blank, return in spotlight */
  refresh: (apply: () => void) => void
  growHeadline: (grown: boolean) => void
  deploy: {
    deploying: () => void
    live: () => void
    hide: () => void
  }
  reset: () => void
}

const HEADLINE = 'sunday pottery — small batches, most saturdays'

/** The fake mobile-browser chrome pinned under the bar: URL pill + home
 *  indicator. Gives the bar something to float above so the phone frame's big
 *  radius wraps browser chrome, not the widget itself. Idempotent. */
export function mountBrowserChrome(): void {
  if (document.querySelector('.demo-chrome')) return
  if (!document.getElementById('demo-styles')) {
    const style = el('style', undefined, (n) => {
      n.id = 'demo-styles'
      n.textContent = MINISITE_STYLES
    })
    document.head.appendChild(style)
  }
  const chrome = el('div', 'demo-chrome')
  chrome.append(
    el('span', 'demo-url', (n) => (n.textContent = 'sundaypottery.com')),
    el('span', 'demo-home'),
  )
  document.body.appendChild(chrome)
}

export function mountMinisite(): Minisite {
  if (!document.getElementById('demo-styles')) {
    const style = el('style', undefined, (n) => {
      n.id = 'demo-styles'
      n.textContent = MINISITE_STYLES
    })
    document.head.appendChild(style)
  }

  const site = el('div', 'demo-site')
  const headline = el('h1', 'demo-headline', (n) => (n.textContent = HEADLINE))
  const chip = el('div', 'demo-chip', (n) => {
    n.append(
      el('span', 'dot'),
      el('span', 'label', (s) => (s.textContent = 'deploying')),
    )
  })
  const nav = el('div', 'demo-nav')
  nav.append(el('span', 'logo'), el('span', 'sp'), el('i'), el('i'), el('i'))
  const img = el('div', 'demo-img', (n) => {
    n.innerHTML =
      '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true">' +
      '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17.5 10 12l4 4 2.5-2.5 3 3"/></svg>'
  })
  site.append(
    nav,
    headline,
    img,
    el('div', 'demo-bar w1'),
    el('div', 'demo-bar w2'),
    el('div', 'demo-rule'),
  )
  document.body.append(site, chip)

  const label = chip.querySelector('.label') as HTMLElement

  return {
    dim: () => site.classList.add('backdrop'),
    refresh: (apply) => {
      site.classList.add('refreshing')
      setTimeout(() => {
        apply()
        site.classList.remove('refreshing', 'backdrop')
        site.classList.add('spotlight')
      }, 420)
    },
    growHeadline: (grown) => {
      headline.classList.toggle('grown', grown)
    },
    deploy: {
      deploying: () => {
        label.textContent = 'deploying'
        chip.classList.remove('live')
        chip.classList.add('show', 'deploying')
      },
      live: () => {
        label.textContent = 'live'
        chip.classList.remove('deploying')
        chip.classList.add('show', 'live')
      },
      hide: () => chip.classList.remove('show', 'deploying', 'live'),
    },
    reset: () => {
      headline.classList.remove('grown')
      site.classList.remove('spotlight', 'backdrop', 'refreshing')
      chip.classList.remove('show', 'deploying', 'live')
      label.textContent = 'deploying'
    },
  }
}
