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
    throw new Error(data.error_description || data.msg || `auth failed (${res.status})`)
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
  } catch {
    wipeSession()
    setAuth('anon')
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
