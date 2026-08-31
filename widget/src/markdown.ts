// Escape-first markdown → HTML. Deliberately small: bold, italic, inline code,
// fenced code, links, dash + ordered lists, headings, blockquotes, hr,
// paragraphs. NEVER emits raw host HTML. (No tables or strikethrough — poor
// fit for a phone-width transcript.)

import { AGENT_TAGS } from './config'

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Fleet-agent mentions: a bare "@pixels" becomes that agent's colored tag. Built
// once, longest handle first so "@closeout-jobs" wins over "@closeout"; runs
// after the stash below, so a backticked `@pixels` stays plain code. "a@pixels"
// (no leading space) is an address, not a mention.
const HANDLES = Object.keys(AGENT_TAGS).sort((a, b) => b.length - a.length)
const MENTION = HANDLES.length ? new RegExp(`(^|[\\s(>])@(${HANDLES.join('|')})(?![\\w-])`, 'g') : null

function agentTags(s: string): string {
  if (!MENTION) return s
  return s.replace(MENTION, (_m, pre: string, handle: string) => {
    const c = AGENT_TAGS[handle]
    return `${pre}<span class="ak-at" style="color:${c};background:${c}1f;border-color:${c}4d">@${handle}</span>`
  })
}

/** User turns render as plain text (no markdown), but mentions still tag. */
export function renderUserText(src: string): string {
  return agentTags(escape(src ?? ''))
}

// Inline spans run on already-escaped text, so the only '<'/'>' present are ours.
// Code spans, markdown links, and bare URLs are stashed as placeholders first so
// the later passes (autolink, bold/italic) can never corrupt them — e.g. a URL
// inside backticks must not become an anchor, and asterisks in a URL must not
// become <em>.
function inline(s: string): string {
  const stash: string[] = []
  const keep = (html: string): string => `\uE000${stash.push(html) - 1}\uE000`
  const anchor = (href: string, label: string): string =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
  const stashed = s
    .replace(/`([^`]+)`/g, (_m, c) => keep(`<code>${c}</code>`))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text, href) => keep(anchor(href, text)))
    // Bare URLs → clickable, trimming common trailing punctuation ("visit https://x.com.")
    .replace(/https?:\/\/[^\s<>()\uE000]*[^\s<>().,;:!?'"\uE000]/g, (u) => keep(anchor(u, u)))
  return agentTags(stashed)
    .replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre, c) => `${pre}<em>${c}</em>`)
    .replace(/\uE000(\d+)\uE000/g, (_m, i) => stash[Number(i)] ?? '')
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
      const info = fence[1].trim().toLowerCase()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // consume closing fence (or EOF)
      // ```options → tappable buttons (chat.ts wires the click → send). Body
      // lines are already HTML-escaped, so each is safe as both attribute and
      // label; degrade to a plain code block if the block is empty.
      if (info === 'options') {
        const opts = body.map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean)
        if (opts.length) {
          out.push(
            `<div class="ak-opts">${opts
              .map((o) => `<button type="button" class="ak-opt" data-send="${o}">${o}</button>`)
              .join('')}</div>`,
          )
          continue
        }
      }
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
      if (!olist.length) {
        const n = parseInt(oli[1], 10)
        olStart = Number.isNaN(n) ? 1 : n // 0 is a valid list start
      }
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
