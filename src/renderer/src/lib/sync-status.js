import { autoSyncText, keyOf as syncKey } from '../hooks/useAutoSync.js'

// The overall sync state of every folder bound to a cloud: the status bar
// item and the 云空间 title show the same thing. null when nothing is bound.
// { state: 'ok'|'busy'|'confirm'|'error'|'off', text, title }
export function syncSummary({ sync, autoSync, syncAuto, t }) {
  const bound = (sync?.registered || []).filter((entry) => entry.connectionId)
  if (!sync?.supported || !bound.length) return null
  const byFolder = autoSync?.byFolder || {}
  const results = bound.map((entry) => byFolder[syncKey(entry.rootPath)]).filter(Boolean)
  const lastAt = Math.max(0, ...results.filter((r) => r.kind === 'done' || r.kind === 'idle').map((r) => r.at))
  let state = 'ok'
  let text = lastAt
    ? t('status.sync.done', { time: new Date(lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
    : t('status.sync.ready')
  if (sync.busyRoot) {
    state = 'busy'
    text = sync.progress?.waiting ? t('status.sync.waiting') : t('status.sync.busy')
  } else if (results.some((r) => r.kind === 'confirm')) {
    state = 'confirm'
    text = t('status.sync.confirm')
  } else if (results.some((r) => r.kind === 'error')) {
    state = 'error'
    text = t('status.sync.error')
  } else if (syncAuto === false) {
    state = 'off'
    text = t('status.sync.off')
  }
  const title = [
    ...bound.map((entry) => {
      const name = entry.name || String(entry.rootPath).split(/[\\/]/).filter(Boolean).pop()
      return `${name}: ${autoSyncText(byFolder[syncKey(entry.rootPath)], t) || t('status.sync.never')}`
    }),
    t('status.sync.open')
  ].join('\n')
  return { state, text, title }
}
