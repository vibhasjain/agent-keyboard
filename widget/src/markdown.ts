// Escape-first markdown → HTML. Deliberately small: bold, italic, inline code,
// fenced code, links, dash + ordered lists, headings, blockquotes, hr,
// paragraphs. NEVER emits raw host HTML. (No tables or strikethrough — poor
// fit for a phone-width transcript.)

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Inline spans run on already-escaped text, so the only '<'/'>' present are ours.
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre, c) => `${pre}<em>${c}</em>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text, href) => {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
    })
}

export function renderMarkdown(src: string): string {
  const lines = escape(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  let para: string[] = []
  let list: string[] = []
  let olist: string[] = []
  let olStart = 1
  let quote: string[] = []

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`)
      para = []
    }
  }
  const flushList = () => {
    if (list.length) {
      out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`)
      list = []
    }
  }
  const flushOList = () => {
    if (olist.length) {
      const start = olStart !== 1 ? ` start="${olStart}"` : ''
      out.push(`<ol${start}>${olist.map((li) => `<li>${inline(li)}</li>`).join('')}</ol>`)
      olist = []
    }
  }
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`)
      quote = []
    }
  }
  const flushBlocks = () => {
    flushPara()
    flushList()
    flushOList()
    flushQuote()
  }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block.
    const fence = line.match(/^```(.*)$/)
    if (fence) {
      flushBlocks()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // consume closing fence (or EOF)
      out.push(`<pre><code>${body.join('\n')}</code></pre>`)
      continue
    }

    // Heading.
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      flushBlocks()
      const level = h[1].length
      out.push(`<h${level}>${inline(h[2])}</h${level}>`)
      i++
      continue
    }

    // Horizontal rule — must run BEFORE the bullet match ("---" / "***").
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushBlocks()
      out.push('<hr>')
      i++
      continue
    }

    // Blockquote — the source is escaped before splitting, so '>' is '&gt;'.
    const bq = line.match(/^&gt;\s?(.*)$/)
    if (bq) {
      flushPara()
      flushList()
      flushOList()
      quote.push(bq[1])
      i++
      continue
    }

    const li = line.match(/^\s*[-*]\s+(.*)$/)
    if (li) {
      flushPara()
      flushOList()
      flushQuote()
      list.push(li[1])
      i++
      continue
    }

    const oli = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/)
    if (oli) {
      flushPara()
      flushList()
      flushQuote()
      if (!olist.length) olStart = parseInt(oli[1], 10) || 1
      olist.push(oli[2])
      i++
      continue
    }

    if (line.trim() === '') {
      flushBlocks()
      i++
      continue
    }

    flushList()
    flushOList()
    flushQuote()
    para.push(line.trim())
    i++
  }
  flushBlocks()
  return out.join('')
}
