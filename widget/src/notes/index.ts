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
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $inputRule, $prose } from '@milkdown/kit/utils'
import { blockEdit } from '@milkdown/crepe/feature/block-edit'
import { cursor } from '@milkdown/crepe/feature/cursor'
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip'
import { listItem } from '@milkdown/crepe/feature/list-item'
import { placeholder } from '@milkdown/crepe/feature/placeholder'
import { table } from '@milkdown/crepe/feature/table'
import { toolbar } from '@milkdown/crepe/feature/toolbar'
import { icon } from '../dom'

declare const __AKN_CSS__: string

export interface NotesOptions {
  api: string
  site: string
  getToken: () => Promise<string | null>
  onClose?: () => void
  /** Open straight to this note (a shared ?ak-note= link). */
  note?: string
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

const MENTION_RE = /\[\[([^[\]\n]+)\]\]/g

/** Mirror the open note into ?ak-note= so the address bar is a shareable link. */
function setUrlNote(name: string | null) {
  const u = new URL(location.href)
  if (name) u.searchParams.set('ak-note', name)
  else u.searchParams.delete('ak-note')
  history.replaceState(history.state, '', u)
}

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
  const newBtn = h('button', 'akn-new', '+ New')
  newBtn.type = 'button'
  newBtn.setAttribute('aria-haspopup', 'menu')
  newBtn.setAttribute('aria-expanded', 'false')
  const newMenu = h('div', 'akn-newmenu')
  newMenu.setAttribute('role', 'menu')
  newMenu.hidden = true
  sideHead.append(newBtn, newMenu)
  const list = h('ul', 'akn-list')
  side.append(sideHead, list)

  const main = h('div', 'akn-main')
  // The bar's pattern: round buttons floating in the top corners (no header row,
  // so the note keeps the full height). Top-left steps back to the list (phones,
  // inside a note); top-right closes Notes. Status floats bottom-right.
  const top = h('div', 'akn-top')
  const iconBtn = (cls: string, name: string, label: string) => {
    const b = h('button', `akn-btn ${cls}`)
    b.type = 'button'
    b.setAttribute('aria-label', label)
    b.title = label
    b.appendChild(icon(name, 18))
    return b
  }
  const back = iconBtn('akn-back', 'chevron-left', 'All notes')
  const status = h('span', 'akn-status')
  status.setAttribute('aria-live', 'polite')
  const closeBtn = iconBtn('akn-close', 'x', 'Close notes')
  top.append(back, closeBtn)
  const page = h('div', 'akn-page')
  main.append(page)
  const body = h('div', 'akn-body')
  body.append(side, main)
  root.append(body, top, status)

  // Keyboard up: iOS doesn't shrink the layout viewport, it scrolls it, which
  // pushed the title off-screen. Pin the overlay to the visible viewport instead.
  const vv = window.visualViewport
  const fit = () => {
    if (!vv) return
    root.style.top = `${vv.offsetTop}px`
    root.style.height = `${vv.height}px`
  }
  vv?.addEventListener('resize', fit)
  vv?.addEventListener('scroll', fit)

  const prevOverflow = document.documentElement.style.overflow
  const prevScroll = window.scrollY
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
  // The sidebar: loose notes, then one level of folders. `names` is every note, flat.
  type Item = string | { folder: string; notes: string[] }
  let tree: Item[] = []
  let names: string[] = []
  const setTree = (t: Item[]) => {
    tree = [...t.filter((i) => typeof i === 'string'), ...t.filter((i) => typeof i !== 'string')]
    names = tree.flatMap((i) => (typeof i === 'string' ? [i] : i.notes))
  }
  const mapNotes = (fn: (n: string) => string[]) =>
    setTree(tree.flatMap((i): Item[] => (typeof i === 'string' ? fn(i) : [{ ...i, notes: i.notes.flatMap(fn) }])))
  const folderNames = () => tree.flatMap((i) => (typeof i === 'string' ? [] : [i.folder]))
  // Folder and note names are unique together, so a name always means one thing:
  // [[Folder]] mentions every note in it.
  const taken = (n: string) => names.includes(n) || folderNames().includes(n)
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

  const renderList = (renaming?: string) => {
    list.replaceChildren()
    if (!tree.length) list.appendChild(h('li', 'akn-empty', 'No notes yet'))
    for (const i of tree) {
      if (typeof i === 'string') noteRow(i)
      else {
        folderRow(i.folder, i.folder === renaming)
        for (const n of i.notes) noteRow(n)
      }
    }
    markRows()
  }

  // Rows are flat: a note belongs to the folder row above it, and loose notes sit
  // above every folder, so the DOM order alone says where everything is.
  const isFolder = (c: Element | null) => (c as HTMLElement | null)?.dataset.folder !== undefined
  const fromDom = () => {
    const t: Item[] = []
    let f: { folder: string; notes: string[] } | null = null
    for (const c of list.children as HTMLCollectionOf<HTMLElement>) {
      if (c.dataset.folder !== undefined) t.push((f = { folder: c.dataset.folder, notes: [] }))
      else if (c.dataset.name !== undefined) (f ? f.notes : t).push(c.dataset.name)
    }
    return t
  }
  /** Indent notes in folders; hide those in collapsed ones (unless being dragged
   *  or open). */
  const markRows = () => {
    let folder: string | undefined
    for (const c of list.children as HTMLCollectionOf<HTMLElement>) {
      if (isFolder(c)) folder = c.dataset.folder
      else {
        c.classList.toggle('in', folder !== undefined)
        c.hidden = folder !== undefined && collapsed.has(folder) && !c.classList.contains('dragging') && c.dataset.name !== current
      }
    }
  }
  const folderOf = (li: Element) => {
    let n: Element | null = li
    while (n && !isFolder(n)) n = n.previousElementSibling
    return (n as HTMLElement | null)?.dataset.folder
  }
  const visible = (n: Element | null, dir: 'previousElementSibling' | 'nextElementSibling') => {
    while (n && (n as HTMLElement).hidden) n = n[dir]
    return n
  }
  /** A folder row drags with its notes; a note row alone. */
  const blockOf = (li: HTMLElement) => {
    const rows = [li]
    if (isFolder(li)) for (let n = li.nextElementSibling; n && !isFolder(n); n = n.nextElementSibling) rows.push(n as HTMLElement)
    return rows
  }
  const place = (rows: HTMLElement[], ref: Element | null) => {
    if (rows[rows.length - 1]!.nextElementSibling !== ref) for (const r of rows) list.insertBefore(r, ref)
    markRows()
  }
  const commitDom = () => {
    const next = fromDom()
    if (JSON.stringify(next) === JSON.stringify(tree)) return
    setTree(next)
    saveOrder()
  }

  /** The whole row drags: a mouse after a few px of movement, a finger after a
   *  short hold (so a plain swipe still scrolls the list). Alt+↑/↓ is the keyboard
   *  twin. Returns whether the last press was a drag, so the click can be eaten. */
  const draggable = (li: HTMLElement, b: HTMLButtonElement) => {
    let dragging = false
    let dragged = false
    li.addEventListener('touchmove', (e) => dragging && e.preventDefault(), { passive: false })
    b.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown')
    b.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      e.preventDefault()
      const rows = blockOf(li)
      if (isFolder(li)) {
        // Folders hop over a whole folder; they never land among the loose notes.
        let ref: Element | null
        if (e.key === 'ArrowUp') {
          for (ref = li.previousElementSibling; ref && !isFolder(ref); ) ref = ref.previousElementSibling
          if (!ref) return
        } else {
          ref = rows[rows.length - 1]!.nextElementSibling
          if (!ref) return
          do ref = ref.nextElementSibling
          while (ref && !isFolder(ref))
        }
        place(rows, ref)
      } else if (e.key === 'ArrowUp') {
        // A note steps over a folder row: out of its folder, or into the one above's
        // end (a collapsed one is stepped over whole).
        const prev = visible(li.previousElementSibling, 'previousElementSibling')
        if (!prev) return
        place(rows, prev)
      } else {
        const next = visible(li.nextElementSibling, 'nextElementSibling')
        if (!next) return
        place(rows, visible(next.nextElementSibling, 'nextElementSibling'))
        // Stepped into a collapsed folder: open it so the note stays in view.
        if (li.hidden) toggleFolder(folderOf(li)!, false)
      }
      b.focus()
      commitDom()
    })
    b.oncontextmenu = (e) => dragging && e.preventDefault()
    b.onpointerdown = (e) => {
      if (e.button !== 0) return
      dragged = false // a drag released off its row got no click to eat
      const y0 = e.clientY
      const hold = e.pointerType === 'touch' ? setTimeout(() => start(), 300) : undefined
      let rows: HTMLElement[] = []
      const start = () => {
        dragging = dragged = true
        rows = blockOf(li)
        for (const r of rows) r.classList.add('dragging')
      }
      // Listen on window: moving the row in the DOM would drop pointer capture.
      const move = (ev: PointerEvent) => {
        if (!dragging) {
          if (e.pointerType === 'touch' || Math.abs(ev.clientY - y0) < 4) return
          start()
        }
        // Insert above the first shown row below the pointer, so a row dropped
        // under a collapsed folder lands at the end of it.
        const others = [...list.children].filter((c) => !rows.includes(c as HTMLElement))
        const below = others.find((c) => {
          const r = c.getBoundingClientRect()
          return !(c as HTMLElement).hidden && r.top + r.height / 2 >= ev.clientY
        })
        let i = below ? others.indexOf(below) : others.length
        if (isFolder(li)) while (i < others.length && !isFolder(others[i]!)) i++
        place(rows, others[i] ?? null)
      }
      const drop = () => {
        clearTimeout(hold)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', drop)
        window.removeEventListener('pointercancel', drop)
        if (!dragging) return
        dragging = false
        for (const r of rows) r.classList.remove('dragging')
        markRows()
        // Touch fires no click after a hold, so nothing is left to swallow.
        if (e.pointerType === 'touch') dragged = false
        commitDom()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', drop)
      window.addEventListener('pointercancel', drop)
    }
    return () => {
      const was = dragged
      dragged = false
      return was
    }
  }

  const noteRow = (name: string) => {
    const li = h('li')
    li.dataset.name = name
    const b = h('button', undefined, name)
    b.type = 'button'
    b.setAttribute('aria-current', String(name === current))
    const wasDrag = draggable(li, b)
    b.onclick = () => wasDrag() || void openNote(name)
    const del = h('button', 'akn-del')
    del.type = 'button'
    del.title = 'Delete note'
    del.setAttribute('aria-label', `Delete note ${name}`)
    del.append(icon('trash', 14))
    del.onclick = () => void deleteNote(name)
    li.append(b, del)
    list.appendChild(li)
  }

  // Collapsed folders, remembered per site in this browser.
  const collapsedKey = `akn-collapsed:${opts.site}`
  const collapsed = new Set<string>(JSON.parse(localStorage.getItem(collapsedKey) ?? '[]'))
  const toggleFolder = (folder: string, close = !collapsed.has(folder)) => {
    if (close) collapsed.add(folder)
    else collapsed.delete(folder)
    localStorage.setItem(collapsedKey, JSON.stringify([...collapsed]))
    const toggle = list.querySelector(`[data-folder="${CSS.escape(folder)}"] .akn-toggle`)
    toggle?.setAttribute('aria-expanded', String(!close))
    toggle?.replaceChildren(icon(close ? 'folder' : 'folder-open', 15))
    markRows()
  }

  // A folder renames in place: click its name, Enter (or clicking away) saves,
  // Esc cancels. An empty name removes the folder and keeps its notes. The
  // folder icon collapses it (open folder icon while expanded). The trash
  // removes the folder the same way: its notes move out, nothing is deleted.
  const folderRow = (folder: string, renaming: boolean) => {
    const li = h('li', 'akn-folder')
    li.dataset.folder = folder
    const toggle = h('button', 'akn-toggle')
    toggle.type = 'button'
    toggle.setAttribute('aria-label', `Show notes in ${folder}`)
    toggle.setAttribute('aria-expanded', String(!collapsed.has(folder)))
    toggle.append(icon(collapsed.has(folder) ? 'folder' : 'folder-open', 15))
    toggle.onclick = () => toggleFolder(folder)
    const b = h('button')
    b.type = 'button'
    b.title = 'Rename folder'
    b.append(h('span', undefined, folder))
    const wasDrag = draggable(li, b)
    const edit = () => {
      const input = h('input', 'akn-folder-name')
      input.value = folder
      input.setAttribute('aria-label', 'Folder name')
      let done = false
      const commit = (save: boolean) => {
        if (done) return
        done = true
        if (save) renameFolder(folder, cleanName(input.value))
        else renderList()
      }
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit(true)
        } else if (e.key === 'Escape') commit(false)
      }
      input.onblur = () => commit(true)
      b.replaceWith(input)
      input.focus()
      input.select()
    }
    b.onclick = () => wasDrag() || edit()
    const del = h('button', 'akn-del')
    del.type = 'button'
    del.title = 'Delete folder (keeps its notes)'
    del.setAttribute('aria-label', `Delete folder ${folder}, keeping its notes`)
    del.append(icon('trash', 14))
    del.onclick = () =>
      confirm(`Delete the folder "${folder}"? Its notes are kept and move out of it. This can't be undone.`) &&
      renameFolder(folder, '')
    li.append(toggle, b, del)
    list.appendChild(li)
    if (renaming) edit()
  }

  const renameFolder = (from: string, to: string) => {
    if (to && to !== from && taken(to)) {
      setStatus(`"${to}" already exists`, true)
      renderList()
      return
    }
    if (collapsed.has(from)) {
      collapsed.delete(from)
      if (to) collapsed.add(to)
      localStorage.setItem(collapsedKey, JSON.stringify([...collapsed]))
    }
    setTree(
      to
        ? tree.map((i) => (typeof i !== 'string' && i.folder === from ? { ...i, folder: to } : i))
        : tree.flatMap((i) => (typeof i !== 'string' && i.folder === from ? i.notes : [i])),
    )
    renderList()
    if (to !== from) saveOrder()
  }

  const saveOrder = () =>
    void enqueue(() => call('-order', { method: 'PUT', body: JSON.stringify({ names: tree }) })).catch((e) =>
      setStatus(`Order not saved — ${(e as Error).message}`, true),
    )

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
  // A finished [[mention]] renders as a link; clicking it opens that note.
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
      const others = [...names, ...folderNames()].filter((n) => n !== current)
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
            decorations: (state) => {
              const decos: Decoration[] = []
              state.doc.descendants((node, pos) => {
                if (!node.isText) return
                for (const m of node.text!.matchAll(MENTION_RE)) {
                  decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, { class: 'akn-ref' }))
                }
              })
              return DecorationSet.create(state.doc, decos)
            },
            handleClick: (v, pos) => {
              const $pos = v.state.doc.resolve(pos)
              const text = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, '\ufffc')
              const at = $pos.parentOffset
              const m = [...text.matchAll(MENTION_RE)].find((m) => m.index < at && at < m.index + m[0].length)
              if (!m) return false
              const name = m[1]!
              if (names.includes(name)) void openNote(name)
              else if (folderNames().includes(name)) toggleFolder(name, false)
              else setStatus(`No note named "${name}"`, true)
              return true
            },
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
    setUrlNote(name)
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
    // A textarea (not an input) so long names wrap instead of scrolling out of view.
    const title = h('textarea', 'akn-title')
    title.rows = 1
    title.value = name
    title.placeholder = 'Untitled'
    title.setAttribute('aria-label', 'Note name')
    const fitTitle = () => {
      title.style.height = 'auto'
      title.style.height = `${title.scrollHeight}px`
    }
    title.oninput = fitTitle
    const host = h('div')
    inner.append(title, host)
    page.replaceChildren(inner)
    fitTitle()

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
      if (taken(next)) {
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
        setUrlNote(next)
        title.value = next
        mapNotes((n) => [n === from ? next : n])
        renderList()
        setStatus('Saved')
      } catch (e) {
        title.value = from
        setStatus(`Not renamed — ${(e as Error).message}`, true)
      }
    }
    title.onchange = () => void rename().finally(fitTitle)
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

  // iOS only raises the keyboard for a focus() inside the tap itself, and creating
  // a note is async. Focus a stand-in input now; focus moving to the title later
  // keeps the keyboard up.
  const holdKeyboard = () => {
    const proxy = h('input', 'akn-proxy')
    proxy.setAttribute('aria-hidden', 'true')
    proxy.tabIndex = -1
    root.appendChild(proxy)
    proxy.focus()
    return () => proxy.remove()
  }

  const newNote = async () => {
    let name = 'Untitled'
    for (let i = 2; taken(name); i++) name = `Untitled ${i}`
    try {
      await call(`/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ content: '' }) })
    } catch (e) {
      setStatus(`Couldn't create — ${(e as Error).message}`, true)
      return
    }
    setTree([...tree, name])
    saveOrder()
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
    vv?.removeEventListener('resize', fit)
    vv?.removeEventListener('scroll', fit)
    // Drop the editor's focus first so iOS dismisses the keyboard, then undo the
    // layout-viewport scroll it caused, or the bar's taps land offset from what's drawn.
    ;(document.activeElement as HTMLElement | null)?.blur()
    crepe?.destroy()
    setUrlNote(null)
    root.remove()
    document.documentElement.style.overflow = prevOverflow
    window.scrollTo(0, prevScroll)
    openInstance = null
    opts.onClose?.()
  }
  openInstance = { close }

  const newFolder = () => {
    let name = 'New folder'
    for (let i = 2; taken(name); i++) name = `New folder ${i}`
    setTree([...tree, { folder: name, notes: [] }])
    renderList(name)
    saveOrder()
  }
  const showMenu = (show: boolean) => {
    newMenu.hidden = !show
    newBtn.setAttribute('aria-expanded', String(show))
    if (show) (newMenu.firstElementChild as HTMLElement).focus()
  }
  for (const [label, name, run] of [
    ['Note', 'note', () => {
      const release = holdKeyboard()
      void newNote().finally(release)
    }],
    ['Folder', 'folder', newFolder],
  ] as const) {
    const b = h('button')
    b.type = 'button'
    b.setAttribute('role', 'menuitem')
    b.append(icon(name, 16), label)
    b.onclick = () => {
      showMenu(false)
      run()
    }
    newMenu.append(b)
  }
  newMenu.onkeydown = (e) => {
    const items = [...newMenu.children] as HTMLElement[]
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      showMenu(false)
      newBtn.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]!.focus()
    }
  }
  newBtn.onclick = () => showMenu(newMenu.hidden)
  root.addEventListener('pointerdown', (e) => {
    if (!newMenu.hidden && !sideHead.contains(e.target as Node)) showMenu(false)
  })
  closeBtn.onclick = () => void close()
  const closeNote = () => {
    crepe?.destroy()
    crepe = null
    current = null
    setUrlNote(null)
    renderList()
    showBlank()
  }
  back.onclick = async () => {
    await flush()
    closeNote()
  }
  const deleteNote = async (name: string) => {
    if (!confirm(`Delete "${name}"? This can't be undone.`)) return
    if (current === name) {
      clearTimeout(timer)
      dirty = false
    }
    try {
      await enqueue(() => call(`/${encodeURIComponent(name)}`, { method: 'DELETE' }))
    } catch (e) {
      setStatus(`Not deleted — ${(e as Error).message}`, true)
      return
    }
    mapNotes((n) => (n === name ? [] : [n]))
    if (current === name) closeNote()
    else renderList()
    setStatus('Deleted')
  }

  showBlank()
  try {
    setTree((await call('-order')) as Item[])
  } catch (e) {
    setStatus(`Couldn't load notes — ${(e as Error).message}`, true)
  }
  renderList()
  closeBtn.focus()
  if (opts.note) {
    if (names.includes(opts.note)) await openNote(opts.note)
    else setStatus(`No note named "${opts.note}"`, true)
  }
}

;(window as unknown as { AgentKeyboardNotes: { open: typeof open } }).AgentKeyboardNotes = { open }
