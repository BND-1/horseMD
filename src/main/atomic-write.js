import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The copy that becomes the saved file must carry the original's metadata.
// Node's copyFile copies data only on macOS, so Finder tags and other
// extended attributes would vanish on every save; /bin/cp -p keeps them
// (about 1.5 ms). Anywhere else (and if cp fails) copyFile: on Windows it
// keeps attributes and alternate streams.
const copyWithMetadata = (from, to) => new Promise((resolve, reject) => {
  if (process.platform !== 'darwin') {
    fs.copyFile(from, to).then(resolve, reject)
    return
  }
  execFile('/bin/cp', ['-p', from, to], (error) => {
    if (!error) resolve()
    else fs.copyFile(from, to).then(resolve, reject)
  })
})

// Save without a window where the file is half written (a crash, power cut or
// full disk mid-write used to leave a truncated note). The new bytes go to a
// hidden sibling first — a COPY of the file, so permissions and extended
// attributes (Finder tags, Windows streams) come along — are flushed to disk,
// and then replace the file in one rename. A file with several hard links
// keeps the in-place write (a rename would split the links), and so does any
// failure of the copy / rename (a folder we may not create files in, a file
// another program holds open on Windows): the result is never worse than
// before. Exported for test:atomic-save.
async function replaceViaAside(temp, target) {
  const aside = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.old.hmtmp`)
  try {
    await fs.rename(target, aside)
  } catch {
    return false
  }
  try {
    await fs.rename(temp, target)
  } catch {
    try { await fs.rename(aside, target) } catch { /* the old file stays beside it, never lost */ }
    return false
  }
  await fs.rm(aside, { force: true }).catch(() => {})
  return true
}

export async function writeFileAtomic(path, content) {
  let target = path
  try { target = await fs.realpath(path) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  let stat = null
  try { stat = await fs.stat(target) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (stat && (!stat.isFile() || stat.nlink > 1)) {
    await fs.writeFile(target, content, 'utf8')
    return
  }
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.hmtmp`)
  try {
    if (stat) await copyWithMetadata(target, temp)
    const handle = await fs.open(temp, stat ? 'r+' : 'w')
    try {
      await handle.truncate(0)
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temp, target)
        break
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || process.platform !== 'win32') throw error
        // Windows refuses to REPLACE a file another program has open
        // (antivirus, indexers, sync tools), but most programs open files
        // allowing a rename: move the old file aside, put the new one in its
        // place, then remove the old one. For an instant the name does not
        // exist, but nobody ever reads half a file. Retry a few times, then
        // fall back to the in-place write.
        if (stat && await replaceViaAside(temp, target)) break
        if (attempt < 6) { await sleepMs(25 * (attempt + 1)); continue }
        throw error
      }
    }
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    if (['EPERM', 'EACCES', 'EBUSY', 'EXDEV', 'ENOTSUP'].includes(error?.code)) {
      await fs.writeFile(target, content, 'utf8')
      return
    }
    throw error
  }
}
