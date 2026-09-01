// Static config. SB_URL / SB_ANON are placeholders: the server substitutes the
// real values into these two strings when it serves /widget.js, so the anon key
// never lives in the repo. The anon key is public by design - Supabase RLS plus
// the server's single-owner gate do the real access control.

export const SB_URL = '__AK_SUPABASE_URL__'
export const SB_ANON = '__AK_SUPABASE_ANON_KEY__'

// Site ids with per-page sessions; the server substitutes this when serving
// /widget.js (same mechanism as the Supabase placeholders). Unsubstituted
// (dev builds) it matches no site — everything stays site-scoped.
const PAGE_SCOPED_SITES = '__AK_PAGE_SCOPED_SITES__'

// Fleet-agent handles → identity colors + page URLs, substituted by the same
// mechanism from the server's relay registry. Unsubstituted (dev builds) or
// malformed JSON means no tags. These values are interpolated into HTML, so
// only plain handles, 6-digit hex colors, and narrow HTTPS URLs survive.
const AGENT_TAGS_RAW = '__AK_AGENT_TAGS__'
type AgentTag = { c: string; u?: string }
export const AGENT_TAGS: Record<string, AgentTag> = (() => {
  const tags: Record<string, AgentTag> = {}
  try {
    for (const [handle, value] of Object.entries(JSON.parse(AGENT_TAGS_RAW) as Record<string, unknown>)) {
      if (!/^[a-z0-9-]+$/.test(handle) || typeof value !== 'object' || value === null) continue
      const { c, u } = value as { c?: unknown; u?: unknown }
      if (typeof c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c)) continue
      const tag: AgentTag = { c }
      if (typeof u === 'string' && /^https:\/\/[a-z0-9.-]+\/?[a-zA-Z0-9\/_-]*$/.test(u)) tag.u = u
      tags[handle] = tag
    }
  } catch {
    /* unsubstituted placeholder or bad JSON: no tags */
  }
  return tags
})()

// We hand-roll auth and namespace our session under a distinct key so we never
// collide with a host page that runs its own Supabase client (and its storage).
export const AUTH_STORAGE_KEY = 'agent-keyboard-auth'

interface Config {
  site: string
  api: string
  isDev: boolean
  guestDemo: boolean
  guestDemoUrl: string
  // data-summon: mount hidden; ` / ~ (or a triple-tap on touch) summons and
  // dismisses the widget. For pages where visitors shouldn't see the bar.
  summon: boolean
}

export const CONFIG: Config = { site: '', api: '', isDev: false, guestDemo: false, guestDemoUrl: '', summon: false }

/** Resolve site + api base from the widget script element. Returns the site id
 *  (empty string means caller should refuse to mount). */
export function initConfig(script: HTMLScriptElement | null): string {
  const site = script?.getAttribute('data-site')?.trim() || ''
  // Default api = the script's own origin (so one server serves widget + api).
  let origin = location.origin
  try {
    if (script?.src) origin = new URL(script.src).origin
  } catch {
    /* inline/blob script: fall back to page origin */
  }
  const api = (script?.getAttribute('data-api')?.trim() || origin).replace(/\/+$/, '')
  CONFIG.site = site
  CONFIG.api = api
  // Opt-in only: AgentKeyboard.com uses this to turn the signed-out widget into
  // a scripted product tour. Customer/fork embeds keep the normal auth gate.
  const guestDemo = script?.getAttribute('data-guest-demo')
  CONFIG.guestDemo = guestDemo != null && guestDemo !== 'false'
  const summon = script?.getAttribute('data-summon')
  CONFIG.summon = summon != null && summon !== 'false'
  CONFIG.guestDemoUrl = CONFIG.guestDemo
    ? guestDemo?.trim() || new URL('/agent-keyboard-demo.json', location.href).toString()
    : ''
  try {
    const host = new URL(api).hostname
    CONFIG.isDev = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
  } catch {
    /* keep default */
  }
  return site
}

/** Glob match for a URL path: `*` matches within a segment, `**` across
 *  segments, and a trailing `/` matches the whole subtree. Everything else is
 *  literal. Used for the optional data-hide-paths / data-only-paths embed
 *  attributes. */
function pathMatches(pattern: string, path: string): boolean {
  let p = pattern.trim()
  if (!p) return false
  if (p === '/') return path === '/' // bare root = only the home page
  if (p.endsWith('/')) p += '**' // "/admin/" means the whole /admin subtree
  const globstar = '\uE000'
  const rx = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, globstar)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(globstar, 'g'), '.*')
  return new RegExp('^' + rx + '$').test(path)
}

/** The embed can scope where the bar appears WITHOUT editing each page:
 *  `data-hide-paths="/admin/,/checkout"` hides it on those; `data-only-paths`
 *  restricts it to only those. Default (neither set) = every page the embed
 *  is on. Returns whether the bar should mount on the current path. */
export function shouldMountHere(script: HTMLScriptElement | null): boolean {
  const path = location.pathname || '/'
  const list = (attr: string): string[] =>
    (script?.getAttribute(attr) || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  const only = list('data-only-paths')
  if (only.length && !only.some((p) => pathMatches(p, path))) return false
  const hide = list('data-hide-paths')
  if (hide.some((p) => pathMatches(p, path))) return false
  return true
}

/** Mirror of the server's filename-safe per-page conversation normalizer. */
export function pageSlug(path = location.pathname): string {
  let p = path.split(/[?#]/)[0].toLowerCase()
  p = p.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '')
  p = p.replace(/\/index\.html?$/, '').replace(/^index\.html?$/, '').replace(/\.html?$/, '')
  const slug = p.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, 80).replace(/-+$/, '')
}

/** localStorage key namespaced to this site and, when configured, page. */
export function lsKey(suffix: string): string {
  const slug = PAGE_SCOPED_SITES.split(',').includes(CONFIG.site) ? pageSlug() : ''
  if (slug) return `ak:${CONFIG.site}:${slug}:${suffix}`
  return `ak:${CONFIG.site}:${suffix}`
}
