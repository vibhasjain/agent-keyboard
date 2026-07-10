import { readFileSync } from 'node:fs'

const root = new URL('../../', import.meta.url)
const tour = JSON.parse(readFileSync(new URL('site/agent-keyboard-demo.json', root), 'utf8'))
const site = readFileSync(new URL('site/index.html', root), 'utf8')
const runner = readFileSync(new URL('widget/src/guest-demo.ts', root), 'utf8')

const fail = (message) => {
  throw new Error(`[guest-demo] ${message}`)
}

if (typeof tour.intro !== 'string' || !tour.intro.trim()) fail('intro is missing')
if (!Array.isArray(tour.startOptions) || tour.startOptions.length < 3 || tour.startOptions.length > 4) {
  fail('startOptions must contain 3 or 4 choices')
}
if (!tour.turns || typeof tour.turns !== 'object') fail('turns map is missing')

const labels = new Set(Object.keys(tour.turns))
const checkOptions = (where, items) => {
  if (!Array.isArray(items) || items.length < 3 || items.length > 4) fail(`${where} must offer 3 or 4 choices`)
  for (const label of items) {
    if (label !== 'Back to the start' && !labels.has(label)) fail(`${where} points to missing turn "${label}"`)
  }
}
checkOptions('startOptions', tour.startOptions)

const states = new Set(['dim', 'thinking', 'tool', 'assistant'])
for (const [label, turn] of Object.entries(tour.turns)) {
  if (typeof turn.prompt !== 'string' || !turn.prompt.trim()) fail(`${label} has no prompt`)
  if (typeof turn.reply !== 'string' || !turn.reply.trim()) fail(`${label} has no reply`)
  checkOptions(label, turn.options)
  for (const stage of turn.stages || []) {
    if (!Number.isFinite(stage.at) || stage.at < 0) fail(`${label} has an invalid stage time`)
    if (!states.has(stage.state)) fail(`${label} has invalid state "${stage.state}"`)
  }
}

const liveEmbed = site.match(/<script[^>]+src="https:\/\/agent-keyboard\.fly\.dev\/widget\.js"[^>]*><\/script>/)?.[0] || ''
if (!liveEmbed.includes('data-guest-demo')) fail('AgentKeyboard.com live embed is not opted into the guest demo')
for (const copySurface of site.match(/data-copy="[^"]+"/g) || []) {
  if (copySurface.includes('guest-demo')) fail('public install snippet must not opt customer embeds into the tour')
}
if (/import\s+\{[^}]*api[^}]*\}\s+from\s+['"]\.\/api['"]/.test(runner)) {
  fail('guest runner must not import the privileged API client')
}

console.log(`[guest-demo] ${labels.size} turns, all choices resolve, site scope is isolated`)
