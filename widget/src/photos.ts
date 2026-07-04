// Photo attachments: pick from library/camera → downscale on-device → upload on
// attach → chip with a progress ring. getAttachmentIds() feeds the send payload.

import { api } from './api'
import { CONFIG } from './config'
import { el, icon, on } from './dom'

const MAX_EDGE = 1600
const JPEG_QUALITY = 0.85

interface Attachment {
  key: string
  file: File
  blob: Blob | null
  objectUrl: string
  status: 'processing' | 'uploading' | 'done' | 'error'
  progress: number
  id?: string
  chip: HTMLElement
}

export interface Photos {
  el: HTMLElement
  openPicker: () => void
  getAttachmentIds: () => string[]
  takeThumbUrls: () => string[]
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
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    img.src = url
  })
}

export function makePhotos(onChange: () => void): Photos {
  const row = el('div', 'ak-chips')
  const input = el('input', 'ak-file', (n) => {
    n.type = 'file'
    n.accept = 'image/*'
    n.multiple = true
    // No `capture` attr — iOS then offers both the library AND the camera.
  })
  row.appendChild(input)

  const items: Attachment[] = []

  const syncDisplay = () => {
    row.style.display = items.length ? 'flex' : 'none'
  }
  const render = () => {
    syncDisplay()
    onChange()
  }

  const removeItem = (a: Attachment) => {
    const i = items.indexOf(a)
    if (i >= 0) items.splice(i, 1)
    URL.revokeObjectURL(a.objectUrl)
    a.chip.remove()
    render()
  }

  const buildChip = (a: Attachment) => {
    const chip = a.chip
    chip.className = 'ak-chip ' + a.status
    chip.replaceChildren()

    const thumb = el('img', 'ak-chip-img')
    thumb.src = a.objectUrl
    thumb.alt = ''
    chip.appendChild(thumb)

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
      n.setAttribute('aria-label', 'Remove photo')
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
    a.status = a.blob ? 'uploading' : 'processing'
    a.progress = 0
    buildChip(a)
    try {
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
      a.status = 'done'
    } catch {
      a.status = 'error'
    }
    buildChip(a)
    onChange()
  }

  const addFile = (file: File) => {
    const a: Attachment = {
      key: Math.random().toString(36).slice(2),
      file,
      blob: null,
      objectUrl: URL.createObjectURL(file),
      status: 'processing',
      progress: 0,
      chip: el('div', 'ak-chip'),
    }
    items.push(a)
    buildChip(a)
    row.appendChild(a.chip)
    render()
    void upload(a)
  }

  on(input, 'change', () => {
    const files = input.files
    if (files) {
      for (const f of Array.from(files)) if (f.type.startsWith('image/')) addFile(f)
    }
    input.value = '' // allow re-picking the same file
  })

  syncDisplay() // no onChange during construction (caller's callback isn't ready yet)

  return {
    el: row,
    openPicker: () => input.click(),
    getAttachmentIds: () => items.filter((a) => a.status === 'done' && a.id).map((a) => a.id!),
    hasAttachments: () => items.length > 0,
    isUploading: () => items.some((a) => a.status === 'uploading' || a.status === 'processing'),
    // Hand the thumbnail URLs to the caller (for transcript display) WITHOUT
    // revoking them — ownership transfers; they live for the page session.
    takeThumbUrls: () => {
      const urls = items.map((a) => a.objectUrl)
      for (const a of [...items]) a.chip.remove()
      items.length = 0
      render()
      return urls
    },
    clear: () => {
      for (const a of [...items]) {
        URL.revokeObjectURL(a.objectUrl)
        a.chip.remove()
      }
      items.length = 0
      render()
    },
  }
}
