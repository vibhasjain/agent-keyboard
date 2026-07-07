// Typed client for the Agent Keyboard server. Auth header via hand-rolled getToken.
// Reads the SSE stream directly off fetch (no EventSource — we need POST + headers).

import { getToken } from './auth'
import { CONFIG } from './config'

export type SseFrameHandler = (name: string, data: Record<string, unknown>) => void

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function url(path: string): string {
  return `${CONFIG.api}${path}`
}

async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const token = await getToken()
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra || {}),
  }
}

/** The one canonical SSE-over-fetch reader (EventSource can't carry the auth header).
 *  Delivers every frame to onFrame; keepalive comment lines (":") are ignored.
 *  Resolves when the stream closes; an onFrame that throws cancels the reader. */
export async function readSse(path: string, init: RequestInit, onFrame: SseFrameHandler): Promise<void> {
  const headers = await authHeaders(init.headers as Record<string, string> | undefined)
  const res = await fetch(url(path), { ...init, headers })
  if (res.status === 404) throw new HttpError(404, `${path} -> 404`)
  if (!res.ok || !res.body) throw new HttpError(res.status, `${path} -> ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  const handleFrame = (frame: string) => {
    let name = ''
    const dataLines: string[] = []
    for (const raw of frame.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line.startsWith(':')) continue // keepalive / comment
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (!name) return
    let data: Record<string, unknown> = {}
    try {
      data = dataLines.length ? JSON.parse(dataLines.join('\n')) : {}
    } catch {
      /* malformed frame data; deliver the event with an empty payload */
    }
    onFrame(name, data)
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx = buf.indexOf('\n\n')
      while (idx >= 0) {
        handleFrame(buf.slice(0, idx))
        buf = buf.slice(idx + 2)
        idx = buf.indexOf('\n\n')
      }
    }
    if (buf.trim()) handleFrame(buf)
  } catch (e) {
    reader.cancel().catch(() => {})
    throw e
  }
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders({ 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) })
  const res = await fetch(url(path), { ...init, headers })
  if (!res.ok) throw new HttpError(res.status, `${path} -> ${res.status}`)
  return (await res.json()) as T
}

// -- Protocol types -----------------------------------------------------------
export type JobStatus = 'running' | 'done' | 'error' | 'interrupted'

export interface JobRow {
  job_id: string
  site_id: string
  status: JobStatus
  status_line?: string
  result?: unknown
  error?: string
  created_at?: string
  updated_at?: string
}

export interface GitInfo {
  changed?: boolean
  pushed?: boolean
  headSha?: string
  branch?: string
  dirty?: boolean
}

export interface ConversationMessage {
  id: string
  // 'system' + kind:'compact' marks an auto-compaction point (the Claude session
  // compacts over time); rendered as a divider, not a bubble.
  role: 'user' | 'assistant' | 'system'
  kind?: 'compact'
  text: string
  tools?: unknown
  attachments?: number
  photos?: number
  ts?: number | string
}

export interface UploadResult {
  id: string
  path: string
  kind?: 'photo' | 'file'
  name?: string
  mime?: string
  size?: number
}

export interface RealtimeToken {
  value: string
  expires_at?: number
  session_type?: string
  model?: string
}

// -- Endpoints ----------------------------------------------------------------
export const api = {
  /** POST a new message; the response IS the SSE stream (fetch-reader). */
  sendMessage: (
    siteId: string,
    body: { text: string; page: string; idemKey: string; attachmentIds?: string[] },
    onFrame: SseFrameHandler,
  ): Promise<void> =>
    readSse(
      `/sites/${encodeURIComponent(siteId)}/messages`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      onFrame,
    ),

  /** Re-attach to a running/known job: replays state, then live frames. 404 ⇒ throws HttpError(404). */
  jobStream: (jobId: string, onFrame: SseFrameHandler): Promise<void> =>
    readSse(`/jobs/${encodeURIComponent(jobId)}/stream`, { method: 'GET' }, onFrame),

  listJobs: (siteId: string): Promise<{ jobs: JobRow[] }> =>
    jsonFetch(`/jobs?siteId=${encodeURIComponent(siteId)}`),

  /** Forcefully stop a running job. The job's stream then delivers a terminal error. */
  cancelJob: (jobId: string): Promise<{ stopped: boolean }> =>
    jsonFetch(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),

  /** Clean slate: stop active work, reset checkout to origin, and clear conversation context. */
  restartSite: (siteId: string): Promise<{ ok: boolean; cleared?: boolean; reset?: unknown }> =>
    jsonFetch(`/sites/${encodeURIComponent(siteId)}/restart`, { method: 'POST' }),

  conversation: (siteId: string, opts: { limit?: number; before?: string } = {}): Promise<{ messages: ConversationMessage[]; cursor: string | null }> => {
    const q = new URLSearchParams()
    q.set('limit', String(opts.limit ?? 40))
    if (opts.before) q.set('before', opts.before)
    return jsonFetch(`/sites/${encodeURIComponent(siteId)}/conversation?${q.toString()}`)
  },

  /** Upload one photo (multipart, field 'photo', <=15MB). onProgress in 0..1. */
  uploadPhoto: (siteId: string, file: Blob, filename: string, onProgress?: (p: number) => void): Promise<UploadResult> =>
    xhrUpload(url(`/sites/${encodeURIComponent(siteId)}/uploads`), 'photo', file, filename, onProgress),

  /** Upload one arbitrary file (multipart, field 'file', <=15MB). onProgress in 0..1. */
  uploadFile: (siteId: string, file: Blob, filename: string, onProgress?: (p: number) => void): Promise<UploadResult> =>
    xhrUpload(url(`/sites/${encodeURIComponent(siteId)}/uploads`), 'file', file, filename, onProgress),

  realtimeToken: (): Promise<RealtimeToken> => jsonFetch(`/realtime/token`, { method: 'POST' }),
}

// XHR (not fetch) so we get upload progress events for the chip's progress ring.
async function xhrUpload(
  fullUrl: string,
  field: 'photo' | 'file',
  file: Blob,
  filename: string,
  onProgress?: (p: number) => void,
): Promise<UploadResult> {
  const token = await getToken()
  const form = new FormData()
  form.append(field, file, filename)
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', fullUrl)
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult)
        } catch {
          reject(new Error('bad upload response'))
        }
      } else {
        reject(new HttpError(xhr.status, `upload -> ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(new Error('upload failed'))
    xhr.send(form)
  })
}
