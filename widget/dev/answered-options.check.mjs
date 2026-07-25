// answerFor() decides whether an assistant turn's option chips are spent. Get it
// wrong and either every chip locks forever (dead tour) or an answered chip
// re-sends when tapped in scrollback (the bug this replaced). Pure function, so
// one node:assert pass over the cases that actually occur in a transcript.
//
//   node dev/answered-options.check.mjs

import assert from 'node:assert/strict'
import { build } from 'esbuild'

const out = await build({
  entryPoints: ['src/chat.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
  logLevel: 'silent',
})
const { answerFor } = await import(
  'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
)

const t = (role, text) => ({ role, text })

// The live case: an assistant turn answered by the next user turn.
assert.equal(answerFor([t('assistant', 'pick one'), t('user', 'Show me')], 0), 'Show me')

// The last turn in the transcript is unanswered — its chips must stay tappable.
assert.equal(answerFor([t('user', 'hi'), t('assistant', 'pick one')], 1), undefined)

// Two assistant turns in a row: the earlier one is still unanswered.
assert.equal(answerFor([t('assistant', 'a'), t('assistant', 'b'), t('user', 'x')], 0), undefined)
assert.equal(answerFor([t('assistant', 'a'), t('assistant', 'b'), t('user', 'x')], 1), 'x')

// A compact divider (system) or a failed send (error) sits between the two without
// answering anything — look past both.
assert.equal(answerFor([t('assistant', 'a'), t('system', '— compacted —'), t('user', 'x')], 0), 'x')
assert.equal(answerFor([t('assistant', 'a'), t('error', 'network'), t('user', 'x')], 0), 'x')

// Only assistant turns own options; a user turn never marks anything.
assert.equal(answerFor([t('user', 'a'), t('user', 'b')], 0), undefined)

// Out of range / empty transcript.
assert.equal(answerFor([], 0), undefined)
assert.equal(answerFor([t('assistant', 'a')], 5), undefined)

// A user turn with empty text still counts as an answer (all chips spent, none lit).
assert.equal(answerFor([t('assistant', 'a'), { role: 'user' }], 0), '')

console.log('answered-options: ok')
