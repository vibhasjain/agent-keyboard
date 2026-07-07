// Inline attachments for the prompt bar. The camera path keeps the old
// photo behavior: downscale on-device, upload as a normalized image, show a
// thumbnail. The paperclip path accepts arbitrary files and stages them raw.

import { api } from './api'
import { CONFIG } from './config'
import { el, icon, on } from './dom'

const MAX_EDGE = 1600
const JPEG_QUALITY = 0.85

type AttachmentKind = 'photo' | 'file'

interface Attachment {
  key: string
  kind: AttachmentKind
  file: File
  blob: Blob | null
  objectUrl?: string
  displayName: string
  status: 'processing' | 'uploading' | 'done' | 'error'
  progress: number
  id?: string
  chip: HTMLElement
}

export interface AttachmentPreviews {
  thumbs?: string[]
  files?: string[]
}

export interface Photos {
  el: HTMLElement
  openPicker: () => void
  openFilePicker: () => void
  /** Feed Files straight into the attach pipeline (paste/drop). Returns how many were accepted. */
  addFiles: (files: Iterable<File>) => number
  getAttachmentIds: () => string[]
  takePreviews: () => AttachmentPreviews
  hasAttachments: () => boolean
  isUploading: () => boolean
  clear: () => void
}

async function downscale(file: File): Promise<Blob> {
  let width: number
  let height: number
  let source: CanvasImageSource

  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
    width = bmp.width
    height = bmp.height
    source = bmp
  } catch {
    const img = await loadImage(file)
    width = img.naturalWidth
    height = img.naturalHeight
    source = img
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return file
  ctx.drawImage(source, 0, 0, w, h)
  if ('close' in source && typeof (source as ImageBitmap).close === 'function') (source as ImageBitmap).close()

  return await new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b || file), 'image/jpeg', JPEG_QUALITY)
  })
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    img.src = url
  })
}

function displayName(file: File): string {
  return file.name?.trim() || 'attachment'
}

function extLabel(file: File): string {
  const name = displayName(file)
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1) : ''
  if (ext) return ext.slice(0, 5).toUpperCase()
  const subtype = file.type.split('/')[1]
  return (subtype || 'FILE').slice(0, 5).toUpperCase()
}

export function makePhotos(onChange: () => void): Photos {
  const row = el('div', 'ak-chips')
  const photoInput = el('input', 'ak-file', (n) => {
    n.type = 'file'
    n.accept = 'image/*'
    n.multiple = true
    // No `capture` attr — iOS then offers both the library AND the camera.
  })
  const fileInput = el('input', 'ak-file', (n) => {
    n.type = 'file'
    n.multiple = true
  })
  row.append(photoInput, fileInput)

  const items: Attachment[] = []

  const syncDisplay = () => {
    row.style.display = items.length ? 'flex' : 'none'
  }
  const render = () => {
    syncDisplay()
    onChange()
  }

  const revokePreview = (a: Attachment) => {
    if (a.objectUrl) URL.revokeObjectURL(a.objectUrl)
  }

  const removeItem = (a: Attachment) => {
    const i = items.indexOf(a)
    if (i >= 0) items.splice(i, 1)
    revokePreview(a)
    a.chip.remove()
    render()
  }

  const buildFileFace = (a: Attachment): HTMLElement => {
    return el('div', 'ak-chip-file', (n) => {
      n.appendChild(icon('paperclip', 15))
      n.appendChild(el('span', 'ak-chip-ext', (s) => (s.textContent = extLabel(a.file))))
    })
  }

  const buildChip = (a: Attachment) => {
    const chip = a.chip
    chip.className = 'ak-chip ' + a.status + (a.kind === 'file' ? ' file' : '')
    chip.title = a.displayName
    chip.replaceChildren()

    if (a.kind === 'photo' && a.objectUrl) {
      const thumb = el('img', 'ak-chip-img')
      thumb.src = a.objectUrl
      thumb.alt = ''
      chip.appendChild(thumb)
    } else {
      chip.appendChild(buildFileFace(a))
    }

    if (a.status === 'uploading' || a.status === 'processing') {
      const ring = el('div', 'ak-chip-ring')
      ring.style.setProperty('--p', String(Math.round(a.progress * 100)))
      chip.appendChild(ring)
    }
    if (a.status === 'done') {
      chip.appendChild(el('div', 'ak-chip-ok', (n) => n.appendChild(icon('check', 9))))
    }
    if (a.status === 'error') {
      chip.appendChild(
        el('div', 'ak-chip-retry', (n) => {
          n.appendChild(icon('retry', 14))
          n.title = 'Tap to retry'
        }),
      )
    }

    const rm = el('button', 'ak-chip-x', (n) => {
      n.type = 'button'
      n.appendChild(icon('x', 8))
      n.setAttribute('aria-label', 'Remove attachment')
    })
    on(rm, 'click', (e) => {
      e.stopPropagation()
      removeItem(a)
    })
    chip.appendChild(rm)

    on(chip, 'click', () => {
      if (a.status === 'error') void upload(a)
    })
  }

  const upload = async (a: Attachment) => {
    a.status = a.kind === 'photo' && !a.blob ? 'processing' : 'uploading'
    a.progress = 0
    buildChip(a)
    try {
      if (a.kind === 'photo') {
        if (!a.blob) {
          a.blob = await downscale(a.file)
          a.status = 'uploading'
          buildChip(a)
        }
        const res = await api.uploadPhoto(CONFIG.site, a.blob, a.file.name || 'photo.jpg', (p) => {
          a.progress = p
          const ring = a.chip.querySelector('.ak-chip-ring') as HTMLElement | null
          if (ring) ring.style.setProperty('--p', String(Math.round(p * 100)))
        })
        a.id = res.id
      } else {
        const res = await api.uploadFile(CONFIG.site, a.file, a.file.name || 'attachment', (p) => {
          a.progress = p
          const ring = a.chip.querySelector('.ak-chip-ring') as HTMLElement | null
          if (ring) ring.style.setProperty('--p', String(Math.round(p * 100)))
        })
        a.id = res.id
      }
      a.status = 'done'
    } catch {
      a.status = 'error'
    }
    buildChip(a)
    onChange()
  }

  const addFile = (file: File, kind: AttachmentKind) => {
    const a: Attachment = {
      key: Math.random().toString(36).slice(2),
      kind,
      file,
      blob: null,
      objectUrl: kind === 'photo' ? URL.createObjectURL(file) : undefined,
      displayName: displayName(file),
      status: kind === 'photo' ? 'processing' : 'uploading',
      progress: 0,
      chip: el('div', 'ak-chip'),
    }
    items.push(a)
    buildChip(a)
    row.appendChild(a.chip)
    render()
    void upload(a)
  }

  on(photoInput, 'change', () => {
    const files = photoInput.files
    if (files) {
      for (const f of Array.from(files)) if (f.type.startsWith('image/')) addFile(f, 'photo')
    }
    photoInput.value = '' // allow re-picking the same file
  })

  on(fileInput, 'change', () => {
    const files = fileInput.files
    if (files) {
      for (const f of Array.from(files)) addFile(f, 'file')
    }
    fileInput.value = ''
  })

  syncDisplay() // no onChange during construction (caller's callback isn't ready yet)

  return {
    el: row,
    openPicker: () => photoInput.click(),
    openFilePicker: () => fileInput.click(),
    addFiles: (files) => {
      let n = 0
      for (const f of files) {
        addFile(f, f.type.startsWith('image/') ? 'photo' : 'file')
        n++
      }
      return n
    },
    getAttachmentIds: () => items.filter((a) => a.status === 'done' && a.id).map((a) => a.id!),
    hasAttachments: () => items.length > 0,
    isUploading: () => items.some((a) => a.status === 'uploading' || a.status === 'processing'),
    // Hand the thumbnail URLs to the caller (for transcript display) WITHOUT
    // revoking them — ownership transfers; they live for the page session.
    takePreviews: () => {
      const done = items.filter((a) => a.status === 'done' && a.id)
      const thumbs = done.filter((a) => a.kind === 'photo' && a.objectUrl).map((a) => a.objectUrl!)
      const files = done.filter((a) => a.kind === 'file').map((a) => a.displayName)
      for (const a of [...items]) {
        if (!(a.status === 'done' && a.kind === 'photo' && a.objectUrl)) revokePreview(a)
        a.chip.remove()
      }
      items.length = 0
      render()
      return {
        ...(thumbs.length ? { thumbs } : {}),
        ...(files.length ? { files } : {}),
      }
    },
    clear: () => {
      for (const a of [...items]) {
        revokePreview(a)
        a.chip.remove()
      }
      items.length = 0
      render()
    },
  }
}
