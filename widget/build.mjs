import { build } from 'esbuild'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

const dev = process.argv.includes('--dev')

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  target: ['safari15', 'ios15'],
  outfile: 'dist/widget.js',
  minify: !dev,
  sourcemap: dev,
  legalComments: 'none',
  charset: 'utf8',
})

const buf = readFileSync('dist/widget.js')
const raw = buf.length
const gz = gzipSync(buf, { level: 9 }).length
const kb = (n) => (n / 1024).toFixed(2)
console.log(`dist/widget.js  ${kb(raw)} KB raw  ·  ${kb(gz)} KB gzip`)
if (gz > 30 * 1024) {
  console.error(`\n⚠  over budget: ${kb(gz)} KB gzip > 30 KB`)
  process.exitCode = 1
}
