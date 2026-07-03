// Google Fonts <link> injection. The stylesheet must live in document.head —
// a shadow root can't load @font-face from a <link> in its own tree. Shared by
// the widget mount (index.ts) and the demo boot (demo/index.ts).

const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@1&family=JetBrains+Mono:wght@400;500&display=swap'

export function injectFonts(): void {
  if (document.getElementById('ak-fonts')) return
  const pre1 = document.createElement('link')
  pre1.rel = 'preconnect'
  pre1.href = 'https://fonts.googleapis.com'
  const pre2 = document.createElement('link')
  pre2.rel = 'preconnect'
  pre2.href = 'https://fonts.gstatic.com'
  pre2.crossOrigin = 'anonymous'
  const link = document.createElement('link')
  link.id = 'ak-fonts'
  link.rel = 'stylesheet'
  link.href = FONTS_HREF
  document.head.append(pre1, pre2, link)
}
