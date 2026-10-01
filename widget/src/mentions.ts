// Composer mentions: #note and @teammate. Once the caret sits after the trigger
// at the start of a word, a listbox pops up above the input and filters as you
// type. Enter/Tab/click picks, Esc dismisses. The server expands a sent #name
// (or the older [[name]]) into a pointer to that note's .md file; a message
// with an @teammate goes to them as a note instead of to the agent.

import { el, on, show } from './dom'

export interface Mentions {
  /** Run first in the textarea's keydown; true = the key was consumed. */
  handleKey: (e: KeyboardEvent) => boolean
}

export function attachMentions(
  ta: HTMLTextAreaElement,
  anchor: HTMLElement,
  loadNotes: () => Promise<string[]>,
  trigger = '#',
  label = 'notes',
): Mentions {
  const id = `ak-mention-${label}`
  const box = el('div', 'ak-mention', (n) => {
    n.id = id
    n.setAttribute('role', 'listbox')
    n.setAttribute('aria-label', label)
  })
  anchor.appendChild(box)
  show(box, false)
  ta.setAttribute('aria-autocomplete', 'list')

  let notes: string[] = []
  let matches: string[] = []
  let active = 0
  let isOpen = false

  const changed = () => ta.dispatchEvent(new Event('input', { bubbles: true }))

  /** The `#query` the caret is in, if any. */
  const context = (): { start: number; query: string } | null => {
    if (ta.selectionStart !== ta.selectionEnd) return null
    const m = ta.value.slice(0, ta.selectionStart).match(new RegExp(`(?:^|\\s)\\${trigger}([^${trigger}\\n]*)$`))
    return m ? { start: ta.selectionStart - m[1]!.length - 1, query: m[1]!.toLowerCase() } : null
  }

  const close = () => {
    isOpen = false
    show(box, false)
    ta.setAttribute('aria-expanded', 'false')
    ta.removeAttribute('aria-activedescendant')
    if (ta.getAttribute('aria-controls') === id) ta.removeAttribute('aria-controls')
  }

  const render = () => {
    box.textContent = ''
    if (!matches.length) {
      box.appendChild(el('div', 'ak-mention-empty', (n) => (n.textContent = notes.length ? `No matching ${label}` : `No ${label} yet`)))
    }
    matches.forEach((name, i) => {
      box.appendChild(
        el('div', 'ak-mention-opt', (n) => {
          n.id = `${id}-${i}`
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
    if (matches.length) ta.setAttribute('aria-activedescendant', `${id}-${active}`)
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
    // Names can hold spaces, so the query can too, until it stops matching a note.
    if (!matches.length && notes.length && /\s/.test(q)) return close()
    active = Math.min(active, Math.max(0, matches.length - 1))
    if (!isOpen) {
      isOpen = true
      active = 0
      ta.setAttribute('aria-expanded', 'true')
      ta.setAttribute('aria-controls', id)
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
    ta.setRangeText(`${trigger}${name} `, ctx.start, ta.selectionStart, 'end')
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
      return false
    },
  }
}
