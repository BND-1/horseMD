import fs from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAX_PDF_IMAGE_BYTES = 32 * 1024 * 1024
export const MAX_PDF_IMAGE_TOTAL_BYTES = 256 * 1024 * 1024

const MIME_EXTENSIONS = Object.freeze({
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp'
})

const URL_EXTENSIONS = new Set(Object.values(MIME_EXTENSIONS))

const imageExtension = (src, contentType = '') => {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime]
  try {
    const extension = extname(new URL(src).pathname).toLowerCase()
    if (URL_EXTENSIONS.has(extension)) return extension
  } catch {
    const extension = extname(String(src || '')).toLowerCase()
    if (URL_EXTENSIONS.has(extension)) return extension
  }
  return '.img'
}

const escapeHtmlAttribute = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

const localImagePath = (src) => {
  if (/^file:/i.test(src)) return fileURLToPath(src)
  if (/^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('/')) return src
  return null
}

const stageLocalImage = async (src, target, maximumBytes) => {
  const sourcePath = localImagePath(src)
  if (!sourcePath) return null
  const info = await fs.stat(sourcePath)
  if (!info.isFile() || info.size > maximumBytes) return null
  await fs.copyFile(sourcePath, target)
  return info.size
}

const readResponseBytes = async (response, maximumBytes) => {
  const reader = response.body?.getReader?.()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length <= maximumBytes ? bytes : null
  }

  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximumBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return size ? Buffer.concat(chunks, size) : null
}

const stageRemoteImage = async (src, assetsDir, basename, fetchImpl, signal, maximumBytes) => {
  if (!/^https?:/i.test(src) || typeof fetchImpl !== 'function') return null
  const response = await fetchImpl(src, {
    signal,
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  })
  if (!response?.ok) return null
  const declaredSize = Number(response.headers?.get?.('content-length') || 0)
  if (declaredSize > maximumBytes) return null
  const bytes = await readResponseBytes(response, maximumBytes)
  if (!bytes?.length) return null
  const extension = imageExtension(src, response.headers?.get?.('content-type'))
  const filename = `${basename}${extension}`
  const target = join(assetsDir, filename)
  await fs.writeFile(target, bytes)
  return { size: bytes.length, filename }
}

export async function stagePdfImages(source, {
  assetsDir,
  fetchImpl,
  signal,
  maximumBytes = MAX_PDF_IMAGE_BYTES,
  maximumTotalBytes = MAX_PDF_IMAGE_TOTAL_BYTES
} = {}) {
  if (!source || typeof source === 'string' || !Array.isArray(source.images) || !source.images.length) {
    return {
      source,
      stagedImages: 0,
      unresolvedImages: 0,
      stagedBytes: 0
    }
  }

  let html = String(source.html || '')
  let stagedImages = 0
  let unresolvedImages = 0
  let stagedBytes = 0
  await fs.mkdir(assetsDir, { recursive: true })

  for (let index = 0; index < source.images.length; index += 1) {
    if (signal?.aborted) throw new Error('PDF preview canceled')
    const image = source.images[index]
    const placeholder = String(image?.placeholder || '')
    const src = String(image?.src || '')
    if (!placeholder || !src || !html.includes(placeholder)) continue

    let replacement = src
    let staged = null
    const available = Math.max(0, Math.min(maximumBytes, maximumTotalBytes - stagedBytes))
    if (available > 0) {
      const basename = `image-${String(index + 1).padStart(4, '0')}`
      try {
        if (localImagePath(src)) {
          const filename = `${basename}${imageExtension(src)}`
          const size = await stageLocalImage(src, join(assetsDir, filename), available)
          if (size != null) staged = { size, filename }
        } else {
          staged = await stageRemoteImage(src, assetsDir, basename, fetchImpl, signal, available)
        }
        if (staged) replacement = `./${staged.filename}`
      } catch {
        staged = null
      }
    }

    if (!staged) {
      unresolvedImages += 1
    } else {
      stagedImages += 1
      stagedBytes += staged.size
    }
    html = html.split(placeholder).join(escapeHtmlAttribute(replacement))
  }

  return {
    source: {
      ...source,
      html,
      images: undefined
    },
    stagedImages,
    unresolvedImages,
    stagedBytes
  }
}
