// Live page swap: after the bar ships a change, show it without a manual reload.
// A job's start snapshots this page's HTML (and its own stylesheet files); after a shipped result the page is
// polled until the deploy lands (new HTML, the same on two polls in a row, so a
// page that differs per request never triggers). Only the smallest changed
// elements are replaced in place (head styles and <title> synced, scroll kept).
// Anything a swap can't do safely reloads instead (the bar's draft and open
// transcript survive it): the turn touched files other than HTML/CSS/docs (JS,
// images, code), a script changed, or the live element no longer matches the
// snapshot because the page's own JS redrew it (e.g. an SPA root).
import { getState, subscribe } from './state'

const POLL_MS = 5000
const POLL_FOR_MS = 4 * 60_000
const RELOAD_AFTER_MS = 90_000 // a reload-only change nothing here can see land (an image): about one deploy

type Snap = { html: string; css: Record<string, string>; frames: Record<string, string> } // css: own stylesheet and script files by URL; frames: same-origin iframes' HTML
let base: Snap | null = null
let taking: Promise<void> | null = null
let watching = 0 // the latest watch; an older one stops

const get = (url: string): Promise<string> =>
  fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
// The page as served, plus its own stylesheet files: a change to an unhashed styles.css leaves the HTML as it was.
const sheetLinks = () => [...document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')].filter((l) => new URL(l.href, location.href).origin === location.origin)
// The page's own script files: running JS can't be swapped (it would run twice), so a change there reloads.
const ownScripts = () => [...document.scripts].map((x) => x.src).filter((u) => u && new URL(u).origin === location.origin)
// Same-origin iframes (e.g. a framed demo page): a change there leaves the top page's HTML as it was.
const frames = () => [...document.querySelectorAll('iframe')].flatMap((f) => {
  try {
    const u = f.contentWindow?.location.href ?? ''
    return u.startsWith(location.origin + '/') ? [[u, f] as const] : []
  } catch { return [] } // cross-origin
})
const unbust = (href: string) => href.replace(/[?&]ak-live=\d+$/, '')
async function snap(): Promise<Snap> {
  const urls = [...sheetLinks().map((l) => unbust(l.href)), ...ownScripts()].sort() // a fixed order, so equal snaps compare equal
  const fr = [...new Set(frames().map(([u]) => u))].sort()
  const [files, framed] = await Promise.all([urls, fr].map((l) => Promise.all(l.map((u) => get(u).catch(() => '')))))
  return { html: await get(location.href), css: Object.fromEntries(urls.map((u, i) => [u, files[i]])), frames: Object.fromEntries(fr.map((u, i) => [u, framed[i]])) }
}

/** Snapshot the page as served, once per job (at its start, before it pushes). */
export function initLiveSwap(): void {
  let busy = false
  subscribe(() => {
    const p = getState().job.phase
    const now = p === 'sending' || p === 'streaming'
    if (now && !busy) taking = snap().then((s) => void (base = s), () => void (base = null))
    busy = now
  })
}

/** After a shipped result: wait for the deploy, then swap (or reload). `updated` runs after a swap. `files` (the
 *  turn's changed paths) beyond HTML/CSS/docs mean a reload. If a swappable change never shows, nothing happens. */
export async function showWhenLive(files: string[] | undefined, updated: () => void): Promise<void> {
  const me = ++watching
  await taking
  const from = base
  if (from == null) return
  const key = (s: Snap) => s.html + JSON.stringify(s.css) + JSON.stringify(s.frames)
  // Reload for anything the page loads that can't be swapped. Not for HTML/CSS/docs, dotfiles (.github…), or server
  // code (Cloudflare/Netlify functions, server/, api/, host config): if that renders this page, its HTML changes and is seen.
  const swappable = !files || files.every((f) => /\.(html?|css|md|txt)$/i.test(f) || /(^|\/)\./.test(f) ||
    /(^|\/)(functions|server|api|backend|workers?|supabase|migrations)\/|(^|\/)(Dockerfile|(fly|wrangler|netlify|vercel)\.(toml|json))$/i.test(f))
  let last: string | null = null
  for (const end = Date.now() + (swappable ? POLL_FOR_MS : RELOAD_AFTER_MS); Date.now() < end && me === watching; ) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const now = await snap().catch(() => null)
    if (now == null || key(now) === key(from)) { last = null; continue }
    if (key(now) !== last) { last = key(now); continue } // wait for it to hold steady
    if (editingPage()) continue // never pull the page out from under someone typing in it
    base = now
    if (!swappable) return location.reload()
    if (ownScripts().some((u) => from.css[u] != null && now.css[u] !== from.css[u])) return location.reload()
    if (now.html !== from.html && !swap(from.html, now.html)) return location.reload()
    // A changed stylesheet file: load a fresh copy beside the old one, then drop the old (no unstyled flash).
    for (const l of sheetLinks()) {
      const href = unbust(l.href)
      if (from.css[href] == null || now.css[href] === from.css[href]) continue
      const n = l.cloneNode() as HTMLLinkElement
      n.href = `${href}${href.includes('?') ? '&' : '?'}ak-live=${Date.now()}`
      n.onload = n.onerror = () => l.remove()
      l.after(n)
    }
    // A changed framed page: reload just that frame.
    for (const [u, f] of frames()) if (from.frames[u] != null && now.frames[u] !== from.frames[u]) f.contentWindow?.location.reload()
    return updated()
  }
  while (!swappable && me === watching && editingPage()) await new Promise((r) => setTimeout(r, POLL_MS))
  if (!swappable && me === watching) location.reload()
}

function editingPage(): boolean {
  const a = document.activeElement as HTMLElement | null
  return !!a && a.id !== 'agent-keyboard-host' && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))
}

/** Patch the live document from the old → new HTML. False = can't safely; reload. */
function swap(fromHtml: string, toHtml: string): boolean {
  const p = new DOMParser()
  const a = p.parseFromString(fromHtml, 'text/html'), b = p.parseFromString(toHtml, 'text/html')
  const scripts = (d: Document) => [...d.scripts].map((s) => s.outerHTML).join('\n')
  if (scripts(a) !== scripts(b)) return false
  // Find every smallest changed element and its live twin first; touch nothing unless all match.
  const units: [Element, Element][] = []
  const live = (path: number[]) => path.reduce<Element | undefined>((n, i) => n?.children[i], document.body)
  const walk = (x: Element, y: Element, path: number[]): boolean => {
    if (x.outerHTML === y.outerHTML) return true
    const sameShell = x.tagName === y.tagName && x.children.length === y.children.length &&
      [...x.attributes].every((t) => y.getAttribute(t.name) === t.value) && x.attributes.length === y.attributes.length &&
      [...x.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join() === [...y.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join()
    if (sameShell) return [...x.children].every((c, i) => walk(c, y.children[i], [...path, i]))
    if (!path.length) return false // the <body> itself changed shape: reload
    const l = live(path)
    // The live element must still be what the old HTML served (an app's JS hasn't redrawn it).
    if (!l || l.tagName !== x.tagName || l.textContent !== x.textContent) return false
    units.push([l, y])
    return true
  }
  if (!walk(a.body, b.body, [])) return false
  const y = scrollY
  for (const [l, n] of units) l.replaceWith(document.importNode(n, true))
  // Head: the title, and stylesheets added or removed.
  if (a.title !== b.title) document.title = b.title
  const sheets = (d: Document) => [...d.head.querySelectorAll('style, link[rel~="stylesheet"]')].map((n) => n.outerHTML)
  const was = sheets(a), now = sheets(b)
  for (const n of document.head.querySelectorAll('style, link[rel~="stylesheet"]')) if (was.includes(n.outerHTML) && !now.includes(n.outerHTML)) n.remove()
  for (const h of now) if (!was.includes(h)) document.head.insertAdjacentHTML('beforeend', h)
  scrollTo(scrollX, y)
  return true
}
