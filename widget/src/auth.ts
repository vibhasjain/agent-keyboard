// Hand-rolled GoTrue REST auth — no supabase-js, so we never collide with a host
// page that runs its own Supabase client. Session lives in
// localStorage['agent-keyboard-auth'].

import { AUTH_STORAGE_KEY, CONFIG, SB_ANON, SB_URL } from './config'
import { setAuth } from './state'

interface Session {
  access_token: string
  refresh_token: string
  expires_at: number // epoch seconds
  email: string
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Session
    if (s && s.access_token && s.refresh_token) return s
  } catch {
    /* malformed / storage blocked */
  }
  return null
}

function writeSession(s: Session): void {
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* storage blocked; token stays in memory for this page load */
  }
}

function wipeSession(): void {
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

export function hasStoredSession(): boolean {
  return readSession() !== null
}

/** The signed-in user's email (from the stored session), or null when signed out. */
export function getSessionEmail(): string | null {
  return readSession()?.email ?? null
}

// ── invite / recovery landing ────────────────────────────────────────────────
// Supabase's verify endpoint redirects the invite/recovery link back to an
// allow-listed URL with the session in the hash (#access_token=…&type=invite).
// Since the bar is on that page, it finishes the flow in place — no dependency
// on a dedicated /welcome page being allow-listed.
export interface InviteToken {
  access_token: string
  refresh_token: string
  type: string
  email: string
}
let pendingInvite: InviteToken | null = null

function emailFromJwt(token: string): string {
  try {
    const payload = token.split('.')[1]
    if (!payload) return ''
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { email?: string }
    return typeof json.email === 'string' ? json.email : ''
  } catch {
    return ''
  }
}

/** Detect an invite/recovery token in the URL hash, stash it, strip it from the
 *  URL (so a reload doesn't re-trigger and the token isn't left visible).
 *  Returns whether one was found. */
export function consumeInviteToken(): boolean {
  try {
    const h = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash
    if (!h) return false
    const p = new URLSearchParams(h)
    const access_token = p.get('access_token') || ''
    const type = p.get('type') || ''
    if (!access_token || !['invite', 'recovery', 'signup', 'magiclink'].includes(type)) return false
    pendingInvite = { access_token, refresh_token: p.get('refresh_token') || '', type, email: emailFromJwt(access_token) }
    try {
      history.replaceState(null, '', location.pathname + location.search)
    } catch {
      /* ignore */
    }
    return true
  } catch {
    return false
  }
}

export function getPendingInvite(): InviteToken | null {
  return pendingInvite
}

/** Set the password for the invited/recovering user with their fresh token,
 *  then establish the session so they're signed in immediately. */
export async function setPasswordWithToken(password: string): Promise<void> {
  const t = pendingInvite
  if (!t) throw new Error('no invite in progress')
  if (SB_URL.startsWith('__AK_')) {
    throw new Error('Server did not inject Supabase config')
  }
  const res = await fetch(`${SB_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: { apikey: SB_ANON, Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const data = (await res.json().catch(() => ({}))) as { email?: string; error_description?: string; msg?: string }
  if (!res.ok) throw new Error(data.error_description || data.msg || `couldn't set password (${res.status})`)
  writeSession({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: nowSec() + 3600,
    email: data.email || t.email || '',
  })
  pendingInvite = null
  setAuth('authed')
}

/** Whether a persisted session exists at boot — drives auth slice without a request. */
export function initAuth(): void {
  setAuth(readSession() ? 'authed' : 'anon')
}

interface GrantResponse {
  access_token: string
  refresh_token: string
  expires_at?: number
  expires_in?: number
  user?: { email?: string }
}

function toSession(r: GrantResponse, fallbackEmail: string): Session {
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: r.expires_at ?? nowSec() + (r.expires_in ?? 3600),
    email: r.user?.email || fallbackEmail,
  }
}

async function grant(grantType: 'password' | 'refresh_token', body: Record<string, string>): Promise<GrantResponse> {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=${grantType}`, {
    method: 'POST',
    headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as GrantResponse & { error_description?: string; msg?: string }
  if (!res.ok || !data.access_token) {
    const err = new Error(data.error_description || data.msg || `auth failed (${res.status})`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return data
}

export async function login(email: string, password: string): Promise<void> {
  if (SB_URL.startsWith('__AK_')) {
    throw new Error('Server did not inject Supabase config — set SUPABASE_URL / SUPABASE_ANON_KEY on the server')
  }
  const r = await grant('password', { email, password })
  writeSession(toSession(r, email))
  setAuth('authed')
}

export function logout(): void {
  wipeSession()
  setAuth('anon')
}

let refreshInFlight: Promise<string | null> | null = null

async function doRefresh(s: Session): Promise<string | null> {
  try {
    const r = await grant('refresh_token', { refresh_token: s.refresh_token })
    const next = toSession(r, s.email)
    writeSession(next)
    return next.access_token
  } catch (e) {
    // Only wipe on a DEFINITIVE auth rejection (the refresh token is actually dead —
    // 4xx invalid_grant). A transient network/5xx failure (common while the server
    // is mid-redeploy) must NOT nuke the session — keep it so the next getToken can
    // retry, instead of forcing a needless re-login.
    const status = (e as { status?: number })?.status
    if (status != null && status >= 400 && status < 500) {
      wipeSession()
      setAuth('anon')
    }
    return null
  }
}

/** Cached token if valid ≥60s; otherwise a single-flight refresh. Failure ⇒ anon. */
export async function getToken(): Promise<string | null> {
  const s = readSession()
  if (!s) return null
  // Dev bypass: mock server ignores Authorization; never try to refresh a fake token.
  if (CONFIG.isDev) return s.access_token
  if (s.expires_at - 60 > nowSec()) return s.access_token
  if (!refreshInFlight) {
    refreshInFlight = doRefresh(s).finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}
