// Escape-first markdown → HTML. Deliberately small: bold, italic, inline code,
// fenced code, links, dash lists, paragraphs. NEVER emits raw host HTML.

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

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block.
    const fence = line.match(/^```(.*)$/)
    if (fence) {
      flushPara()
      flushList()
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

    const li = line.match(/^\s*[-*]\s+(.*)$/)
    if (li) {
      flushPara()
      list.push(li[1])
      i++
      continue
    }

    if (line.trim() === '') {
      flushPara()
      flushList()
      i++
      continue
    }

    flushList()
    para.push(line.trim())
    i++
  }
  flushPara()
  flushList()
  return out.join('')
}
