// Zero-dependency mock of the Agent Keyboard server protocol, for local dev.
// Serves dev/index.html + dist/widget.js and fakes every endpoint the widget
// calls. Authorization is ignored (dev bypass). Run: node dev/mock-server.mjs

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PORT = Number(process.env.PORT || 8098)

let jobSeq = 0
/** siteId -> job */
const jobsBySite = new Map()
/** jobId -> job */
const jobsById = new Map()
/** idemKey -> job (the real server re-tails duplicate idemKeys; mirror that) */
const jobsByIdem = new Map()
/** siteId -> completed turns, appended to /conversation like the real session log */
const turnsBySite = new Map()
/** siteIds whose mock conversation was cleared by restart */
const clearedSites = new Set()
let msgSeq = 0

const frame = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })
  res.write(': ok\n\n')
}

function makeJob(siteId, text) {
  const id = `job_${++jobSeq}_${Math.random().toString(36).slice(2, 7)}`
  const job = {
    id,
    siteId,
    status: 'running',
    frames: [], // replayable history
    writers: new Set(),
    statusLine: { phase: 'starting', detail: 'Starting up', browser: false },
    result: null,
    error: null,
  }
  jobsById.set(id, job)
  jobsBySite.set(siteId, job)

  const push = (name, data) => {
    if (name === 'status') job.statusLine = data
    const f = frame(name, data)
    job.frames.push(f)
    for (const w of job.writers) {
      try {
        w.write(f)
      } catch {
        /* client gone */
      }
    }
  }

  const reply = [
    `## Done`,
    ``,
    `I updated the hero copy on **${siteId}** to read "${(text || 'your change').slice(0, 40)}" and tightened the spacing.`,
    ``,
    `1. edited \`index.html\``,
    `2. committed the change`,
    `3. pushed to \`main\``,
    ``,
    `> Netlify redeploys in about 30s.`,
    ``,
    `---`,
    ``,
    `<script>alert('escaped?')</script>`,
  ].join('\n')
  const words = reply.split(' ')

  const timeline = [
    [200, () => push('job', { job_id: id, target: '/index.html', status: 'running' })],
    [500, () => push('status', { phase: 'starting', detail: 'Starting up', browser: false })],
    [1200, () => push('status', { phase: 'syncing', detail: 'Syncing the repo', browser: true })],
    [2200, () => push('status', { phase: 'starting', detail: 'Booting the agent', browser: true })],
    [3000, () => push('status', { phase: 'thinking', detail: 'Reading the current layout…', browser: true })],
    [4200, () => push('status', { phase: 'tool', detail: 'Editing index.html', browser: true })],
  ]
  // stream assistant tokens (FULL accumulated text each frame)
  let acc = ''
  words.forEach((w, i) => {
    acc += (i ? ' ' : '') + w
    const snapshot = acc
    timeline.push([5000 + i * 120, () => push('assistant', { text: snapshot })])
  })
  const endAt = 5000 + words.length * 120 + 600
  // A browser-only transition repeats the current status line, like production.
  // The widget must hide the indicators without rewinding its assistant ticker.
  timeline.push([6200, () => push('status', { phase: 'tool', detail: 'Editing index.html', browser: false })])
  timeline.push([
    endAt,
    () => {
      job.status = 'done'
      job.result = {
        reply,
        git: { changed: true, pushed: true, headSha: 'a1b2c3d4e5f6a1b2c3d4', branch: 'main', dirty: false },
        usage: { input_tokens: 4200, output_tokens: 180 },
        conversation_id: `conv_${siteId}`,
      }
      push('result', job.result)
      // The real session log now contains this turn — surface it in /conversation.
      const turns = turnsBySite.get(siteId) || []
      turns.push(
        { id: `m${++msgSeq}`, role: 'user', text: text || '', ts: Date.now() },
        { id: `m${++msgSeq}`, role: 'assistant', text: reply, ts: Date.now() },
      )
      turnsBySite.set(siteId, turns)
      for (const w of job.writers) {
        try {
          w.end()
        } catch {
          /* ignore */
        }
      }
      job.writers.clear()
    },
  ])

  for (const [ms, fn] of timeline) setTimeout(fn, ms)
  return job
}

function attach(job, res) {
  sseHead(res)
  for (const f of job.frames) res.write(f) // replay history
  if (job.status === 'done') {
    res.end()
    return
  }
  job.writers.add(res)
  const ka = setInterval(() => {
    try {
      res.write(': ka\n\n')
    } catch {
      /* ignore */
    }
  }, 8000)
  res.on('close', () => {
    clearInterval(ka)
    job.writers.delete(res)
  })
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(obj))
}

async function serveStatic(res, file, type) {
  try {
    const buf = await readFile(join(ROOT, file))
    res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' })
    res.end(buf)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`)
  const p = u.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    })
    res.end()
    return
  }

  // static
  if (p === '/' || p === '/index.html') {
    // Serve the canonical hostile page, but point its data-api at THIS server's port
    // (the committed file pins 8098 per spec; dev may run on any port).
    try {
      let html = await readFile(join(ROOT, 'dev/index.html'), 'utf8')
      html = html.replace('data-api="http://localhost:8098"', `data-api="http://localhost:${PORT}"`)
      // ?guest arms the signed-out scripted tour without a second host page.
      if (u.searchParams.has('guest')) html = html.replace('data-site="halo"', 'data-site="halo" data-guest-demo')
      if (u.searchParams.has('transcript-qa')) html = html.replace('data-site="halo"', 'data-site="transcript-qa"')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
      res.end(html)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
    return
  }
  if (p === '/favicon.ico') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
    res.end()
    return
  }
  // The tour script the widget fetches from its own origin (lives with the site).
  if (p === '/agent-keyboard-demo.json') return serveStatic(res, '../site/agent-keyboard-demo.json', 'application/json')
  if (p === '/widget.js') return serveStatic(res, 'dist/widget.js', 'text/javascript; charset=utf-8')
  if (p === '/widget.js.map') return serveStatic(res, 'dist/widget.js.map', 'application/json')
  if (p === '/demo.js') return serveStatic(res, 'dist/demo.js', 'text/javascript; charset=utf-8')
  if (p === '/demo.js.map') return serveStatic(res, 'dist/demo.js.map', 'application/json')

  // GET /sites/:id/screen -> repeat one real JPEG frame until the viewer closes.
  let m = p.match(/^\/sites\/([^/]+)\/screen$/)
  if (m && req.method === 'GET') {
    const site = decodeURIComponent(m[1])
    const jpeg = await readFile(join(ROOT, '../site/og.jpg')).then((buf) => buf.toString('base64'))
    const payload = {
      jpeg,
      w: 1200,
      h: 630,
      url: 'https://agentkeyboard.com/live-browser-check',
      title: 'Agent Keyboard live browser',
    }
    sseHead(res)
    const send = () => {
      try {
        res.write(frame('screen', payload))
      } catch {
        /* viewer gone */
      }
    }
    send()
    const timer = setInterval(send, 300)
    console.log(`[mock] screen connected for ${site}`)
    res.on('close', () => {
      clearInterval(timer)
      console.log(`[mock] screen disconnected for ${site}`)
    })
    return
  }

  // GET /demo/:scene -> minimal noindex host page that loads /demo.js for one
  // scene (the marketing site embeds these in iframes). Allowlisted ids only.
  const dm = p.match(/^\/demo\/([a-z]+)$/)
  if (dm && req.method === 'GET') {
    const scene = dm[1]
    if (!['ship', 'photo', 'voice', 'expand', 'login'].includes(scene)) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
      res.end('unknown scene')
      return
    }
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Agent Keyboard demo — ${scene}</title>
<style>html,body{margin:0;background:#0a0a0a}</style>
</head>
<body>
<script src="/demo.js" data-scene="${scene}" defer></script>
</body>
</html>`
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
    res.end(html)
    return
  }

  // POST /sites/:id/messages -> SSE stream (duplicate idemKey re-tails, like prod)
  m = p.match(/^\/sites\/([^/]+)\/messages$/)
  if (m && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let text = ''
      let idemKey = ''
      try {
        const parsed = JSON.parse(body)
        text = parsed.text || ''
        idemKey = parsed.idemKey || ''
      } catch {
        /* ignore */
      }
      const existing = idemKey && jobsByIdem.get(idemKey)
      if (existing) {
        console.log(`[mock] duplicate idemKey ${idemKey} → re-tailing ${existing.id}`)
        attach(existing, res)
        return
      }
      const job = makeJob(decodeURIComponent(m[1]), text)
      if (idemKey) jobsByIdem.set(idemKey, job)
      clearedSites.delete(job.siteId)
      attach(job, res)
    })
    return
  }

  // POST /sites/:id/uploads -> {id, path}
  m = p.match(/^\/sites\/([^/]+)\/uploads$/)
  if (m && req.method === 'POST') {
    req.on('data', () => {}) // drain
    req.on('end', () => {
      const id = `up_${Math.random().toString(36).slice(2, 9)}`
      json(res, 200, { id, path: `uploads/${id}`, kind: 'file', name: 'attachment' })
    })
    return
  }

  // GET /sites/:id/conversation — static seed + turns completed this run
  m = p.match(/^\/sites\/([^/]+)\/conversation$/)
  if (m && req.method === 'GET') {
    const site = decodeURIComponent(m[1])
    if (clearedSites.has(site)) return json(res, 200, { messages: [], cursor: null })
    if (site === 'transcript-qa') {
      const commands = Array.from({ length: 59 }, (_, i) => `$ node cloud/feed.mjs --page ${i + 1}`)
      commands.push('$ node cloud/feed.mjs')
      return json(res, 200, {
        messages: [
          { id: 'qa1', role: 'user', text: 'run the full feed', ts: Date.now() - 5000 },
          { id: 'qa2', role: 'assistant', text: 'Bulk command run finished.', tools: commands, ts: Date.now() - 4000 },
          { id: 'qa3', role: 'user', text: 'check the mixed sequence', ts: Date.now() - 3000 },
          {
            id: 'qa4',
            role: 'assistant',
            text: 'Mixed sequence marker.',
            tools: ['$ git status --short', 'edited widget/src/chat.ts', '$ npm run check', '$ npm run build'],
            parts: [
              { type: 'tools', tools: ['$ git status --short', 'edited widget/src/chat.ts'] },
              { type: 'text', text: 'Mixed sequence marker.' },
              { type: 'tools', tools: ['$ npm run check', '$ npm run build'] },
            ],
            ts: Date.now() - 2000,
          },
        ],
        cursor: null,
      })
    }
    return json(res, 200, {
      messages: [
        { id: 'h1', role: 'user', text: 'make the footer say 2026', ts: Date.now() - 90000 },
        { id: 'h2', role: 'assistant', text: `Updated the footer year to **2026** on ${site}. Pushed \`3f9ab12\`.`, ts: Date.now() - 88000 },
        { id: 'c1', role: 'system', kind: 'compact', text: 'Session compacted', ts: Date.now() - 60000 },
        { id: 'h3', role: 'user', text: 'tighten the nav spacing', ts: Date.now() - 50000 },
        { id: 'h4', role: 'assistant', text: 'Done — trimmed the nav gap to 12px and pushed `7c2f0aa`.', ts: Date.now() - 48000 },
        ...(turnsBySite.get(site) || []),
      ],
      cursor: null,
    })
  }

  // POST /sites/:id/restart -> clear mock history and report a clean reset.
  m = p.match(/^\/sites\/([^/]+)\/restart$/)
  if (m && req.method === 'POST') {
    const site = decodeURIComponent(m[1])
    const job = jobsBySite.get(site)
    if (job && job.status === 'running') {
      job.status = 'error'
      job.error = { kind: 'stopped', detail: 'Stopped.' }
      for (const w of job.writers) {
        try {
          w.write(frame('error', job.error))
          w.end()
        } catch {
          /* ignore */
        }
      }
      job.writers.clear()
    }
    jobsBySite.delete(site)
    turnsBySite.delete(site)
    clearedSites.add(site)
    return json(res, 200, {
      ok: true,
      cancelled: job ? 1 : 0,
      cleared: true,
      conversation_id: `conv_${site}_${Date.now().toString(36)}`,
      reset: { headSha: 'restart1234567890', branch: 'main', dirty: false },
    })
  }

  // GET /jobs/:id/stream -> replay + live (404 if unknown)
  m = p.match(/^\/jobs\/([^/]+)\/stream$/)
  if (m && req.method === 'GET') {
    const job = jobsById.get(decodeURIComponent(m[1]))
    if (!job) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
      res.end('unknown job')
      return
    }
    attach(job, res)
    return
  }

  // GET /jobs?siteId=
  if (p === '/jobs' && req.method === 'GET') {
    const site = u.searchParams.get('siteId') || ''
    const job = jobsBySite.get(site)
    return json(res, 200, {
      jobs: job
        ? [
            {
              job_id: job.id,
              site_id: job.siteId,
              status: job.status,
              status_line: job.statusLine,
              result: job.result,
              error: job.error,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ]
        : [],
    })
  }

  // POST /realtime/token (dev stub; real WebRTC dial to OpenAI will fail without a real key)
  if (p === '/realtime/token' && req.method === 'POST') {
    return json(res, 200, { value: 'ephemeral-dev-token', expires_at: Date.now() / 1000 + 60, session_type: 'transcription' })
  }

  res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
  res.end('not found')
})

server.listen(PORT, () => {
  console.log(`agent-keyboard mock server → http://localhost:${PORT}`)
})
