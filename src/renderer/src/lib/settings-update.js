import { isNewerVersion } from '../paths.js'

export function resolveUpdateCheckState(result) {
  if (!result?.ok || !result.latest) return { status: 'error', info: null }
  if (isNewerVersion(result.latest, result.current)) {
    return {
      status: 'available',
      info: {
        latest: result.latest,
        url: result.url || ''
      }
    }
  }
  return { status: 'uptodate', info: null }
}
