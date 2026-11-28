import { build, transform } from 'esbuild'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

const dev = process.argv.includes('--dev')
const kb = (n) => (n / 1024).toFixed(2)

// esbuild can't see inside the CSS template strings in styles.ts, so minify
// them at build time: evaluate the module and re-emit each string export as
// minified CSS (drops comments and whitespace, ~2.3 KB gzip).
const minifyStyles = {
  name: 'minify-styles',
  setup(b) {
    b.onLoad({ filter: /styles\.ts$/ }, async ({ path }) => {
      const { code } = await transform(readFileSync(path, 'utf8'), { loader: 'ts', format: 'esm' })
      const mod = await import('data:text/javascript,' + encodeURIComponent(code))
      let out = ''
      for (const [k, v] of Object.entries(mod)) {
        const css = (await transform(v, { loader: 'css', minify: true })).code.trim()
        out += `export const ${k} = ${JSON.stringify(css)}\n`
      }
      return { contents: out, loader: 'js' }
    })
  },
}

/** Build one IIFE bundle and enforce its gzip budget. */
async function bundle(entry, outfile, gzipBudgetKB, extra = {}) {
  await build({
    ...extra,
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: ['safari15', 'ios15'],
    outfile,
    minify: !dev,
    sourcemap: dev,
    legalComments: 'none',
    charset: 'utf8',
    plugins: dev ? [] : [minifyStyles],
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
// 32: transcript tool lines (2026-09-04); Docker's zlib measures ~0.2 KB heavier than local.
// 33: the typewriter mark inlined as the corner glyph (~0.8 KB, 2026-09-25).
// 34: Notes button + lazy loader + [[mention]] autocomplete (~1.2 KB, 2026-10-01).
// 35: iOS keyboard fixes (scroll snap-back, keep the latest message in view), 2026-10-01.
// 39: keep expanded command groups open while a turn streams (2026-11-25).
// 39.5: moving a site's one-tap approval with the dry run and opt-ins (spec 20, 2026-11-26).
// 41: the live page swap after a shipped change, stylesheet files too (spec 26, 2026-11-27).
// 39: the CSS strings are minified at build time (−2.3 KB, 2026-11-27).
// 39.1: a closing bar leaves another docked bar's page margin alone (agentbar.md rule 3, 2026-11-28).
// 39.25: yield the corner box to another bar's full-screen sheet; re-announce our dock on hello (agentbar.md rules 1 and 4, 2026-11-28).
await bundle('src/index.ts', 'dist/widget.js', 39.25)
await bundle('src/demo/index.ts', 'dist/demo.js', 45)

// The notes editor (Milkdown Crepe), lazy-loaded by the widget only when Notes
// opens. Its CSS is bundled separately (resolving Crepe's @imports) and inlined
// as a string the bundle injects into <head>.
const css = await build({
  entryPoints: ['src/notes/style.css'],
  bundle: true,
  minify: !dev,
  write: false,
  outdir: 'dist',
  loader: { '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
})
await bundle('src/notes/index.ts', 'dist/notes.js', 260, {
  define: { __AKN_CSS__: JSON.stringify(css.outputFiles[0].text) },
})
