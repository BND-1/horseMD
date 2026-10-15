const WATCH_IGNORE_RE = /(^|[\\/])(\.(git|obsidian|horsemd)|node_modules)([\\/]|$)/

export const DEFAULT_WATCH_EXTENSIONS = ['md', 'markdown', 'mdx', 'txt']

export function isAbsoluteWatchPath(path) {
  return typeof path === 'string' && (/^\//.test(path) || /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path))
}

export function isRestrictedWatchRoot(path) {
  if (typeof path !== 'string') return true
  const normalized = path.replace(/[\\/]+$/, '')
  if (normalized === '' || normalized === '/' || normalized === '.' || normalized === '..') return true
  if (!isAbsoluteWatchPath(normalized)) return true
  return /^\/(dev|proc|System\/Volumes|private\/var\/(db|folders)|\.vol)(\/|$)/.test(normalized)
}

export function workspaceWatchOptions(extensions = DEFAULT_WATCH_EXTENSIONS) {
  const supported = new Set(extensions.map((extension) => extension.toLowerCase()))
  return {
    ignored: (path, stats) => {
      if (WATCH_IGNORE_RE.test(path) || isRestrictedWatchRoot(path)) return true
      // Chokidar calls this before and after stat. Keep directories so new
      // documents are discovered, but do not allocate watchers for data/assets.
      if (!stats || stats.isDirectory()) return false
      return !supported.has(path.match(/\.([^./\\]+)$/)?.[1]?.toLowerCase())
    },
    ignoreInitial: true,
    depth: 12,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  }
}
