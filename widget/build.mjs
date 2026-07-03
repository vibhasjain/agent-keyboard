import { build } from 'esbuild'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

const dev = process.argv.includes('--dev')
const kb = (n) => (n / 1024).toFixed(2)

/** Build one IIFE bundle and enforce its gzip budget. */
async function bundle(entry, outfile, gzipBudgetKB) {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: ['safari15', 'ios15'],
    outfile,
    minify: !dev,
    sourcemap: dev,
    legalComments: 'none',
    charset: 'utf8',
  })

  const buf = readFileSync(outfile)
  const gz = gzipSync(buf, { level: 9 }).length
  console.log(`${outfile}  ${kb(buf.length)} KB raw  ·  ${kb(gz)} KB gzip`)
  if (gz > gzipBudgetKB * 1024) {
    console.error(`\n⚠  over budget: ${kb(gz)} KB gzip > ${gzipBudgetKB} KB`)
    process.exitCode = 1
  }
}

// The shipped widget, and the marketing-site demo bundle (real components,
// scripted fakes). The demo carries scene scripts + timeline so its budget is
// looser; it never ships to a customer's page.
await bundle('src/index.ts', 'dist/widget.js', 30)
await bundle('src/demo/index.ts', 'dist/demo.js', 45)
