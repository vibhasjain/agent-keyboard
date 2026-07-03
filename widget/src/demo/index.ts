// Demo boot. Loaded on a scene page with <script src="/demo.js" data-scene="…">.
// Mounts the REAL bar into a shadow root, points its API client at scripted
// fakes, and runs the scene's looping timeline. No auth, no network, no server.

import { mountBar } from '../bar'
import { CONFIG } from '../config'
import { injectFonts } from '../fonts'
import { setAuth } from '../state'
import { STYLES } from '../styles'
import { installFakeApi } from './fake-api'
import { mountBrowserChrome, mountMinisite } from './minisite'
import { getScene } from './scenes'
import { DEMO_STYLES } from './styles'
import { runTimeline } from './timeline'

// currentScript must be read synchronously at execution time (before boot may
// defer to DOMContentLoaded) — a deferred classic script still sets it.
const script = document.currentScript as HTMLScriptElement | null
const scene = script?.getAttribute('data-scene') ?? 'ship'
const sceneDef = getScene(scene)

CONFIG.site = `demo-${scene}`
CONFIG.api = location.origin

installFakeApi(sceneDef.script) // must precede mountBar

function boot(): void {
  const host = document.createElement('div')
  host.id = 'agent-keyboard-host'
  host.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:2147483000;pointer-events:none;'
  document.body.appendChild(host)

  const shadow = host.attachShadow({ mode: 'open' })
  const base = document.createElement('style')
  base.textContent = STYLES
  const demo = document.createElement('style')
  demo.textContent = DEMO_STYLES
  shadow.append(base, demo)
  injectFonts() // Google Fonts <link> must live in document.head

  setAuth('authed') // visual only — never initAuth / bootRehydrate in the demo
  mountBar(shadow)

  const minisite = mountMinisite()
  mountBrowserChrome() // URL pill + home bar under the widget, every scene
  const t = sceneDef.build({ shadow, minisite })
  runTimeline(t.steps, { loopAt: t.loopAt, posterAt: t.posterAt, onReset: t.onReset })

  window.parent?.postMessage({ type: 'ak-demo-ready', scene }, '*')
}

if (document.body) boot()
else document.addEventListener('DOMContentLoaded', boot, { once: true })
