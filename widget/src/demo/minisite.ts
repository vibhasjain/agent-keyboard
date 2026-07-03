// The fake site behind the bar (light DOM). A real serif headline that visibly
// grows, skeleton body bars, and a deploy chip that goes deploying → live. Its
// stylesheet is injected once into document.head.

import { el } from '../dom'
import { MINISITE_STYLES } from './styles'

export interface Minisite {
  growHeadline: (grown: boolean) => void
  deploy: {
    deploying: () => void
    live: () => void
    hide: () => void
  }
  reset: () => void
}

const HEADLINE = 'sunday pottery — small batches, most saturdays'

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
  site.append(
    headline,
    el('div', 'demo-bar w1'),
    el('div', 'demo-bar w2'),
    el('div', 'demo-rule'),
  )
  document.body.append(site, chip)

  const label = chip.querySelector('.label') as HTMLElement

  return {
    growHeadline: (grown) => headline.classList.toggle('grown', grown),
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
      chip.classList.remove('show', 'deploying', 'live')
      label.textContent = 'deploying'
    },
  }
}
