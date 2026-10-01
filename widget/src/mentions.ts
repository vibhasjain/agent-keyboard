// Obsidian-style [[note]] mentions in the composer. Typing `[` auto-closes it;
// once the caret sits inside `[[…` a listbox of the site's notes pops up above
// the input and filters as you type. Enter/Tab/click picks, Esc dismisses. The
// server expands a sent [[name]] into a pointer to that note's .md file.

import { el, on, show } from './dom'

export interface Mentions {
  /** Run first in the textarea's keydown; true = the key was consumed. */
  handleKey: (e: KeyboardEvent) => boolean
}

export function attachMentions(
  ta: HTMLTextAreaElement,
  anchor: HTMLElement,
  loadNotes: () => Promise<string[]>,
): Mentions {
  const box = el('div', 'ak-mention', (n) => {
    n.id = 'ak-mention-list'
    n.setAttribute('role', 'listbox')
    n.setAttribute('aria-label', 'Notes')
  })
  anchor.appendChild(box)
  show(box, false)
  ta.setAttribute('aria-controls', box.id)
  ta.setAttribute('aria-autocomplete', 'list')

  let notes: string[] = []
  let matches: string[] = []
  let active = 0
  let isOpen = false

  const changed = () => ta.dispatchEvent(new Event('input', { bubbles: true }))

  /** The `[[query` the caret is in, if any. */
  const context = (): { start: number; query: string } | null => {
    if (ta.selectionStart !== ta.selectionEnd) return null
    const m = ta.value.slice(0, ta.selectionStart).match(/\[\[([^[\]\n]*)$/)
    return m ? { start: ta.selectionStart - m[0].length, query: m[1]!.toLowerCase() } : null
  }

  const close = () => {
    isOpen = false
    show(box, false)
    ta.setAttribute('aria-expanded', 'false')
    ta.removeAttribute('aria-activedescendant')
  }

  const render = () => {
    box.textContent = ''
    if (!matches.length) {
      box.appendChild(el('div', 'ak-mention-empty', (n) => (n.textContent = notes.length ? 'No matching notes' : 'No notes yet')))
    }
    matches.forEach((name, i) => {
      box.appendChild(
        el('div', 'ak-mention-opt', (n) => {
          n.id = `ak-mention-${i}`
          n.setAttribute('role', 'option')
          n.setAttribute('aria-selected', String(i === active))
          n.textContent = name
          // mousedown, not click: keep focus (and the caret) in the textarea.
          on(n, 'mousedown', (e) => {
            e.preventDefault()
            pick(name)
          })
        }),
      )
    })
    if (matches.length) ta.setAttribute('aria-activedescendant', `ak-mention-${active}`)
    else ta.removeAttribute('aria-activedescendant')
    box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  const refresh = () => {
    const ctx = context()
    if (!ctx) return close()
    // Prefix matches first, then anywhere-in-name matches.
    const q = ctx.query
    matches = [
      ...notes.filter((n) => n.toLowerCase().startsWith(q)),
      ...notes.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q)),
    ]
    active = Math.min(active, Math.max(0, matches.length - 1))
    if (!isOpen) {
      isOpen = true
      active = 0
      ta.setAttribute('aria-expanded', 'true')
      // Fresh list each time the popup opens, so a note made a moment ago shows up.
      void loadNotes().then((list) => {
        notes = list
        if (isOpen) refresh()
      }, () => {})
    }
    show(box, true)
    render()
  }

  const pick = (name: string) => {
    const ctx = context()
    if (!ctx) return close()
    const caret = ta.selectionStart
    const end = ta.value.slice(caret).startsWith(']]') ? caret + 2 : caret
    ta.setRangeText(`[[${name}]]`, ctx.start, end, 'end')
    close()
    changed()
  }

  on(ta, 'input', refresh)
  on(ta, 'click', refresh)
  on(ta, 'blur', close)

  return {
    handleKey: (e) => {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false
      if (isOpen) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (matches.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
          render()
        } else if ((e.key === 'Enter' || e.key === 'Tab') && matches[active]) {
          pick(matches[active]!)
        } else if (e.key === 'Escape') {
          close()
        } else return false
        e.preventDefault()
        e.stopPropagation()
        return true
      }
      const s = ta.selectionStart
      const collapsed = s === ta.selectionEnd
      // Auto-close brackets, skip over a closing one, delete an empty pair together.
      if (e.key === '[' && collapsed) {
        ta.setRangeText('[]', s, s, 'start')
        ta.setSelectionRange(s + 1, s + 1)
      } else if (e.key === ']' && collapsed && ta.value[s] === ']') {
        ta.setSelectionRange(s + 1, s + 1)
        return (e.preventDefault(), true)
      } else if (e.key === 'Backspace' && collapsed && s > 0 && ta.value[s - 1] === '[' && ta.value[s] === ']') {
        ta.setRangeText('', s - 1, s + 1, 'start')
      } else return false
      e.preventDefault()
      changed()
      return true
    },
  }
}
