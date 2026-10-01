// The notes editor: a full-screen Notion-style markdown page for bigger change
// requests. A separate bundle (dist/notes.js) the widget lazy-loads on first use,
// so the Milkdown weight never touches widget.js. Each note is one .md file on the
// server (GET/PUT /sites/:id/notes/:name); edits autosave as you type. The agent
// is pointed at a note when a prompt mentions it as [[name]].

// Crepe's builder + only the features notes need: the default Crepe class
// statically pulls KaTeX and every CodeMirror language (~1.8 MB gzip).
import { CrepeBuilder } from '@milkdown/crepe/builder'
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { linkSchema } from '@milkdown/kit/preset/commonmark'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $inputRule, $prose } from '@milkdown/kit/utils'
import { blockEdit } from '@milkdown/crepe/feature/block-edit'
import { cursor } from '@milkdown/crepe/feature/cursor'
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip'
import { listItem } from '@milkdown/crepe/feature/list-item'
import { placeholder } from '@milkdown/crepe/feature/placeholder'
import { table } from '@milkdown/crepe/feature/table'
import { toolbar } from '@milkdown/crepe/feature/toolbar'

declare const __AKN_CSS__: string

export interface NotesOptions {
  api: string
  site: string
  getToken: () => Promise<string | null>
  onClose?: () => void
}

const SAVE_DELAY_MS = 300

/** Filename-safe note name: no slashes/brackets/control chars, no leading dot. */
const cleanName = (s: string) =>
  s.replace(/[/\\[\]\x00-\x1f]/g, '').replace(/^[.\s]+/, '').trim().slice(0, 80)

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text) n.textContent = text
  return n
}

// Typing `[text](url)` turns into a link (commonmark has no input rule for it).
const linkRule = $inputRule(
  (ctx) =>
    new InputRule(/\[([^\]]+)\]\(([^()\s]+)\)$/, (state, [, text, href], start, end) => {
      const link = linkSchema.type(ctx)
      return state.tr.replaceWith(start, end, state.schema.text(text!, [link.create({ href })])).removeStoredMark(link)
    }),
)

/** remark escapes `[` in text; keep [[mentions]] readable in the saved .md. */
const unescapeMentions = (md: string) =>
  md.replace(/\\\[\\\[([^\]\n]+?)\\?\]\\?\]/g, (_, n: string) => `[[${n.replace(/\\(.)/g, '$1')}]]`)

let openInstance: { close: () => Promise<void> } | null = null

export async function open(opts: NotesOptions): Promise<void> {
  if (openInstance) return
  if (!document.getElementById('akn-css')) {
    const style = h('style')
    style.id = 'akn-css'
    style.textContent = __AKN_CSS__
    document.head.appendChild(style)
  }

  const base = `${opts.api}/sites/${encodeURIComponent(opts.site)}/notes`
  const call = async (path: string, init: RequestInit = {}) => {
    const token = await opts.getToken()
    const res = await fetch(base + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error((body as { error?: string }).error || `HTTP ${res.status}`)
    }
    return res.json()
  }

  // -- DOM --
  const root = h('div', 'akn')
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Notes')
  // Keep Escape (Milkdown's menus use it) from reaching the bar's own Esc handling.
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') e.stopPropagation()
  })
  const side = h('nav', 'akn-side')
  const sideHead = h('div', 'akn-side-head')
  const newBtn = h('button', 'akn-new', '+ New note')
  newBtn.type = 'button'
  sideHead.append(h('h2', undefined, 'Notes'), newBtn)
  const list = h('ul', 'akn-list')
  side.append(sideHead, list)

  const main = h('div', 'akn-main')
  const top = h('div', 'akn-top')
  const back = h('button', 'akn-back', '‹ Notes')
  back.type = 'button'
  const status = h('span', 'akn-status')
  status.setAttribute('aria-live', 'polite')
  const delBtn = h('button', 'akn-delete', 'Delete')
  delBtn.type = 'button'
  const closeBtn = h('button', 'akn-close', 'Close')
  closeBtn.type = 'button'
  top.append(back, status, delBtn, closeBtn)
  const page = h('div', 'akn-page')
  main.append(top, page)
  root.append(side, main)

  const prevOverflow = document.documentElement.style.overflow
  document.documentElement.style.overflow = 'hidden'
  document.body.appendChild(root)
  // Top layer, like the bar: escapes the transform the docked transcript can put
  // on <html> (which would trap a fixed overlay in the narrowed page). Older
  // engines fall back to the fixed + max z-index overlay.
  if (typeof root.showPopover === 'function') {
    root.popover = 'manual'
    root.showPopover()
  }

  // -- state --
  let names: string[] = []
  let current: string | null = null
  let crepe: CrepeBuilder | null = null
  let markdown = ''
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<unknown> = Promise.resolve()

  const setStatus = (text: string, err = false) => {
    status.textContent = text
    status.className = 'akn-status' + (err ? ' err' : '')
  }

  const renderList = () => {
    list.replaceChildren()
    if (!names.length) list.appendChild(h('li', 'akn-empty', 'No notes yet'))
    for (const name of names) {
      const li = h('li')
      const b = h('button', undefined, name)
      b.type = 'button'
      b.setAttribute('aria-current', String(name === current))
      b.onclick = () => void openNote(name)
      li.appendChild(b)
      list.appendChild(li)
    }
  }

  // Saves run one at a time, in order, so a slow request can't land after a newer one.
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn)
    chain = p.catch(() => {})
    return p
  }

  const flush = () => {
    clearTimeout(timer)
    if (!dirty || !current) return chain
    dirty = false
    const name = current
    const content = markdown
    setStatus('Saving…')
    return enqueue(() => call(`/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ content }) }))
      .then(() => setStatus('Saved'))
      .catch((e) => {
        dirty = true
        setStatus(`Not saved — ${(e as Error).message}`, true)
      })
  }

  // [[note]] mentions inside a note, like the bar's composer: `[[` pops a list of
  // the other notes that filters as you type; Enter/Tab/click picks, Esc dismisses.
  const mentions = () => {
    const box = h('div', 'akn-mention')
    box.setAttribute('role', 'listbox')
    box.setAttribute('aria-label', 'Notes')
    box.hidden = true
    root.appendChild(box)
    let view: EditorView
    let matches: string[] = []
    let active = 0
    let range: { from: number; to: number } | null = null
    const hide = () => {
      range = null
      box.hidden = true
    }
    const pick = (name: string) => {
      if (!range) return
      view.dispatch(view.state.tr.insertText(`[[${name}]]`, range.from, range.to))
      view.focus()
    }
    const render = () => {
      box.replaceChildren()
      if (!matches.length) box.appendChild(h('div', 'akn-mention-empty', 'No matching notes'))
      matches.forEach((name, i) => {
        const o = h('div', 'akn-mention-opt', name)
        o.setAttribute('role', 'option')
        o.setAttribute('aria-selected', String(i === active))
        // mousedown, not click: keep focus (and the caret) in the editor.
        o.onmousedown = (e) => {
          e.preventDefault()
          pick(name)
        }
        box.appendChild(o)
      })
      box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    }
    const update = (v: EditorView) => {
      view = v
      const { empty, $from } = v.state.selection
      const m = empty && v.hasFocus() && $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc').match(/\[\[([^[\]\n]*)$/)
      if (!m) return hide()
      const q = m[1]!.toLowerCase()
      const others = names.filter((n) => n !== current)
      matches = [
        ...others.filter((n) => n.toLowerCase().startsWith(q)),
        ...others.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q)),
      ]
      const closed = $from.parent.textBetween($from.parentOffset, Math.min($from.parentOffset + 2, $from.parent.content.size)) === ']]'
      if (!range) active = 0
      active = Math.min(active, Math.max(0, matches.length - 1))
      range = { from: $from.pos - m[0].length, to: $from.pos + (closed ? 2 : 0) }
      const at = v.coordsAtPos(range.from)
      box.style.left = `${Math.min(at.left, innerWidth - 300)}px`
      box.style.top = `${at.bottom + 6}px`
      box.hidden = false
      render()
    }
    return $prose(
      () =>
        new Plugin({
          view: (v) => {
            view = v
            return { update, destroy: () => box.remove() }
          },
          props: {
            handleKeyDown: (_v, e) => {
              if (!range || e.isComposing) return false
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (matches.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
                render()
              } else if ((e.key === 'Enter' || e.key === 'Tab') && matches[active]) pick(matches[active]!)
              else if (e.key === 'Escape') hide()
              else return false
              e.preventDefault()
              return true
            },
            handleDOMEvents: { blur: () => (hide(), false) },
          },
        }),
    )
  }

  const showBlank = () => {
    page.replaceChildren(h('div', 'akn-blank', 'Pick a note, or start a new one.'))
    root.classList.remove('has-note')
  }

  const openNote = async (name: string, focusTitle = false) => {
    await flush()
    crepe?.destroy()
    crepe = null
    current = name
    renderList()
    root.classList.add('has-note')
    setStatus('')
    let content = ''
    try {
      content = ((await call(`/${encodeURIComponent(name)}`)) as { content: string }).content
    } catch (e) {
      setStatus(`Couldn't open — ${(e as Error).message}`, true)
      return
    }
    if (current !== name) return // another note was picked while loading

    const inner = h('div', 'akn-page-inner')
    const title = h('input', 'akn-title')
    title.value = name
    title.placeholder = 'Untitled'
    title.setAttribute('aria-label', 'Note name')
    const host = h('div')
    inner.append(title, host)
    page.replaceChildren(inner)

    markdown = content
    crepe = new CrepeBuilder({ root: host, defaultValue: content })
      .addFeature(cursor)
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(blockEdit)
      .addFeature(toolbar)
      .addFeature(table)
      .addFeature(placeholder, { text: 'Describe the change — type / for blocks' })
    // `-` bullets (remark's default is `*`), so a note round-trips the way people write it.
    crepe.editor.config((ctx) => ctx.update(remarkStringifyOptionsCtx, (o) => ({ ...o, bullet: '-' as const })))
    crepe.editor.use(linkRule).use(mentions())
    crepe.on((l) =>
      l.markdownUpdated((_ctx, md) => {
        markdown = unescapeMentions(md)
        dirty = true
        clearTimeout(timer)
        timer = setTimeout(() => void flush(), SAVE_DELAY_MS)
      }),
    )
    await crepe.create()

    // Rename on commit (blur / Enter). The server refuses to clobber an existing note.
    const rename = async () => {
      const next = cleanName(title.value)
      if (!next || next === current || !current) {
        title.value = current ?? ''
        return
      }
      if (names.includes(next)) {
        setStatus(`"${next}" already exists`, true)
        title.value = current
        return
      }
      await flush()
      const from = current
      setStatus('Saving…')
      try {
        await enqueue(() =>
          call(`/${encodeURIComponent(next)}`, { method: 'PUT', body: JSON.stringify({ content: markdown, from }) }),
        )
        current = next
        title.value = next
        names = [next, ...names.filter((n) => n !== from)]
        renderList()
        setStatus('Saved')
      } catch (e) {
        title.value = from
        setStatus(`Not renamed — ${(e as Error).message}`, true)
      }
    }
    title.onchange = () => void rename()
    title.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        title.blur()
        ;(host.querySelector('.ProseMirror') as HTMLElement | null)?.focus()
      }
    }
    if (focusTitle) {
      title.focus()
      title.select()
    }
  }

  const newNote = async () => {
    let name = 'Untitled'
    for (let i = 2; names.includes(name); i++) name = `Untitled ${i}`
    try {
      await call(`/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ content: '' }) })
    } catch (e) {
      setStatus(`Couldn't create — ${(e as Error).message}`, true)
      return
    }
    names = [name, ...names]
    await openNote(name, true)
  }

  // Last-chance save if the tab closes mid-debounce (keepalive outlives the page).
  const onUnload = () => {
    if (!dirty || !current) return
    void opts.getToken().then((token) =>
      fetch(`${base}/${encodeURIComponent(current!)}`, {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ content: markdown }),
      }),
    )
  }
  window.addEventListener('pagehide', onUnload)

  const close = async () => {
    await flush()
    window.removeEventListener('pagehide', onUnload)
    crepe?.destroy()
    root.remove()
    document.documentElement.style.overflow = prevOverflow
    openInstance = null
    opts.onClose?.()
  }
  openInstance = { close }

  newBtn.onclick = () => void newNote()
  closeBtn.onclick = () => void close()
  const closeNote = () => {
    crepe?.destroy()
    crepe = null
    current = null
    renderList()
    showBlank()
  }
  back.onclick = async () => {
    await flush()
    closeNote()
  }
  delBtn.onclick = async () => {
    const name = current
    if (!name || !confirm(`Delete "${name}"? This can't be undone.`)) return
    clearTimeout(timer)
    dirty = false
    try {
      await enqueue(() => call(`/${encodeURIComponent(name)}`, { method: 'DELETE' }))
    } catch (e) {
      setStatus(`Not deleted — ${(e as Error).message}`, true)
      return
    }
    names = names.filter((n) => n !== name)
    if (current === name) closeNote()
    else renderList()
    setStatus('Deleted')
  }

  showBlank()
  try {
    names = ((await call('')) as { name: string }[]).map((n) => n.name)
  } catch (e) {
    setStatus(`Couldn't load notes — ${(e as Error).message}`, true)
  }
  renderList()
  closeBtn.focus()
}

;(window as unknown as { AgentKeyboardNotes: { open: typeof open } }).AgentKeyboardNotes = { open }
