import { useEffect, useState } from 'react'

const hasExternalFiles = (event) =>
  Array.from(event.dataTransfer?.types || []).includes('Files')

const IMAGE_NAME_RE = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i
const isImageFile = (file) => {
  if (file?.type?.startsWith('image/') || IMAGE_NAME_RE.test(file?.name || '')) return true
  try {
    return IMAGE_NAME_RE.test(window.api.getPathForDroppedFile?.(file) || '')
  } catch {
    return false
  }
}

const hasImageDropInsideEditor = (event) => {
  if (!event.target?.closest?.('.ProseMirror')) return false
  const items = [...(event.dataTransfer?.items || [])]
  const files = [...(event.dataTransfer?.files || [])]
  return items.some((item) => item.kind === 'file' && item.type.startsWith('image/')) ||
    files.some(isImageFile)
}

const droppedNativePaths = (dataTransfer, accept = () => true) => {
  const resolvePath = window.api.getPathForDroppedFile
  if (!resolvePath) return []
  const paths = []
  const seen = new Set()
  for (const file of [...(dataTransfer?.files || [])]) {
    if (!accept(file)) continue
    let path = ''
    try {
      path = resolvePath(file)
    } catch {
      path = ''
    }
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

// Desktop shell drop-open boundary. External image drops inside ProseMirror
// stay owned by editor-dom-content.js so they are inserted/persisted rather
// than opened as tabs. Internal tab/sidebar/outline drags do not carry the
// native `Files` type and are ignored.
export function useDropOpen({ enabled, openPaths, addFolder }) {
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (!enabled || !window.api.classifyDroppedPaths || !window.api.getPathForDroppedFile) {
      setActive(false)
      return undefined
    }

    const openDroppedPaths = async (paths) => {
      if (!paths.length) return
      const entries = await window.api.classifyDroppedPaths(paths)
      const files = []
      for (const entry of entries || []) {
        if (entry?.type === 'dir') addFolder(entry.path)
        else if (entry?.type === 'file') files.push(entry.path)
      }
      if (files.length) await openPaths(files)
    }

    const onDragOver = (event) => {
      if (!hasExternalFiles(event)) return
      if (hasImageDropInsideEditor(event)) {
        setActive(false)
        return
      }
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      setActive(true)
    }

    const onDragLeave = (event) => {
      if (!event.relatedTarget) setActive(false)
    }

    const onDrop = (event) => {
      if (!hasExternalFiles(event)) return
      setActive(false)
      if (hasImageDropInsideEditor(event)) {
        // Let the editor insert every image in the payload, while still opening
        // any accompanying documents/folders instead of silently discarding
        // them. Synthetic/clipboard Files have no native path and are ignored.
        const remaining = droppedNativePaths(event.dataTransfer, (file) => !isImageFile(file))
        void openDroppedPaths(remaining).catch(() => {})
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const paths = droppedNativePaths(event.dataTransfer)
      void openDroppedPaths(paths)
        // The dropped item may disappear or become unreadable after the native
        // drag starts. Treat that like a cancelled drop instead of leaving an
        // unhandled renderer promise rejection.
        .catch(() => {})
    }

    // Capture drop before ProseMirror can consume an unsupported non-image
    // file. The explicit image exception above leaves its existing target-side
    // handler untouched.
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('dragleave', onDragLeave, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('dragleave', onDragLeave, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [enabled, openPaths, addFolder])

  return active
}
