import { isNewerVersion } from '../paths.js'

export function resolveUpdateCheckState(result) {
  if (!result?.ok || !result.latest) return { status: 'error', info: null }
  if (isNewerVersion(result.latest, result.current)) {
    return {
      status: 'available',
      info: {
        latest: result.latest,
        current: result.current,
        url: result.url || '',
        name: result.name || '',
        notes: result.notes || '',
        download: result.download || null
      }
    }
  }
  return { status: 'uptodate', info: null }
}
