// Images in content pasted from another document (renderer
// lib/pasted-image-refs.js). Each relative url is read against the SOURCE
// document's folder; the result is what the target writes instead:
//   - the file lies inside the target's folder → a relative path to it;
//   - else, saved target → a copy in the target's ./assets (the rule for any
//     image inserted from a local file), reusing an identical file there;
//   - unsaved target → a copy in the paste folder as a file:// URL, which
//     the first save moves into ./assets (image:inlineForSave).
// Only image files are touched (the source path comes from the clipboard,
// which other programs can write). A url that cannot be resolved is left out
// of the result, so the paste keeps it as written.
import { pathToFileURL } from 'node:url'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import fs from 'node:fs/promises'
import { realpathSync, constants as fsConstants } from 'node:fs'

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?|heic|heif|jxl)$/i
const MAX_BYTES = 64 * 1024 * 1024
const MAX_URLS = 200

const realOr = (path) => {
  try { return realpathSync.native(path) } catch { return resolve(path) }
}

const exists = async (path) => {
  try { await fs.access(path); return true } catch { return false }
}

async function sameBytes(a, b, size) {
  try {
    const st = await fs.stat(b)
    if (!st.isFile() || st.size !== size) return false
    const [x, y] = await Promise.all([fs.readFile(a), fs.readFile(b)])
    return x.equals(y)
  } catch {
    return false
  }
}

// `name`, `name-1`, … in `dir`: the first free one, or one already holding
// the same bytes (pasting the same content twice copies the image once).
async function copyInto(dir, sourceFile, size) {
  await fs.mkdir(dir, { recursive: true })
  const safe = basename(sourceFile).replace(/[\\/:*?"<>|]/g, '_') || 'image.png'
  const ext = extname(safe)
  const stem = basename(safe, ext) || 'image'
  for (let n = 0; n < 10000; n++) {
    const file = join(dir, n ? `${stem}-${n}${ext}` : `${stem}${ext}`)
    if (await exists(file)) {
      if (await sameBytes(sourceFile, file, size)) return file
      continue
    }
    try {
      await fs.copyFile(sourceFile, file, fsConstants.COPYFILE_EXCL)
      return file
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
    }
  }
  throw new Error('No free file name.')
}

async function sourceFileFor(srcDir, url) {
  const candidates = []
  try { candidates.push(decodeURI(url)) } catch {}
  candidates.push(url)
  for (const c of candidates) {
    const file = resolve(srcDir, c)
    try {
      const st = await fs.stat(file)
      if (st.isFile()) return { file, size: st.size }
    } catch {}
  }
  return null
}

export async function importPastedImages({ sourceDocPath, targetDocPath, urls, pasteDir }) {
  const results = {}
  if (typeof sourceDocPath !== 'string' || !isAbsolute(sourceDocPath) || !Array.isArray(urls)) return results
  if (targetDocPath != null && (typeof targetDocPath !== 'string' || !isAbsolute(targetDocPath))) return results
  const srcDir = dirname(sourceDocPath)
  const targetDir = targetDocPath ? dirname(targetDocPath) : null
  const targetReal = targetDir ? realOr(targetDir) : null
  for (const url of urls.slice(0, MAX_URLS)) {
    if (typeof url !== 'string' || !url || url in results) continue
    try {
      const found = await sourceFileFor(srcDir, url)
      if (!found || !IMAGE_EXT_RE.test(found.file) || found.size > MAX_BYTES) continue
      const real = realOr(found.file)
      if (targetReal && real.startsWith(targetReal.endsWith(sep) ? targetReal : targetReal + sep)) {
        results[url] = relative(targetReal, real).split(sep).join('/')
      } else if (targetDir) {
        const file = await copyInto(join(targetDir, 'assets'), real, found.size)
        results[url] = 'assets/' + basename(file)
      } else if (pasteDir) {
        results[url] = pathToFileURL(await copyInto(pasteDir, real, found.size)).href
      }
    } catch {
      // Left as written.
    }
  }
  return results
}
