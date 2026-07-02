// Static config. SB_URL / SB_ANON are placeholders: the server substitutes the
// real values into these two strings when it serves /widget.js, so the anon key
// never lives in the repo. The anon key is public by design — Supabase RLS plus
// the server's single-owner gate do the real access control.

export const SB_URL = '__AK_SUPABASE_URL__'
export const SB_ANON = '__AK_SUPABASE_ANON_KEY__'

// We hand-roll auth and namespace our session under a distinct key so we never
// collide with a host page that runs its own Supabase client (and its storage).
export const AUTH_STORAGE_KEY = 'agent-keyboard-auth'

interface Config {
  site: string
  api: string
  isDev: boolean
}

export const CONFIG: Config = { site: '', api: '', isDev: false }

/** Resolve site + api base from the widget script element. Returns the site id
 *  (empty string ⇒ caller should refuse to mount). */
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
  try {
    const host = new URL(api).hostname
    CONFIG.isDev = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
  } catch {
    /* keep default */
  }
  return site
}

/** localStorage key namespaced to this site. */
export function lsKey(suffix: string): string {
  return `ak:${CONFIG.site}:${suffix}`
}
