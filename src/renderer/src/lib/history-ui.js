// Local version history + 最近删除 (renderer side). The store lives in main
// (window.api.history*); this module holds the pure helpers shared by
// HistoryDialog / DeletedFilesDialog / Settings › Files, and the event that
// opens the dialogs from anywhere (commands, context menus, settings).
import { diffComm } from 'node-diff3'

export const HISTORY_OPEN_EVENT = 'hm:history-open'

// Mobile builds (and older preloads) have no history store: hide every entry.
export const historySupported = () => typeof window.api?.historyList === 'function'

export function openFileHistory(path) {
  if (!path) return
  window.dispatchEvent(new CustomEvent(HISTORY_OPEN_EVENT, { detail: { kind: 'file', path } }))
}

export function openDeletedFiles() {
  window.dispatchEvent(new CustomEvent(HISTORY_OPEN_EVENT, { detail: { kind: 'deleted' } }))
}

// An IPC rejection without Electron's "Error invoking remote method …" prefix.
export const errorText = (error) =>
  String(error?.message || error || '').replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')

export const reasonLabel = (t, reason) => t(`history.reason.${reason || 'save'}`)

export const baseName = (path) => String(path || '').split(/[\\/]/).filter(Boolean).pop() || String(path || '')

export const dirName = (path) => {
  const value = String(path || '')
  const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  return cut > 0 ? value.slice(0, cut) : value
}

// A path shown relative to the workspace folder that holds it ("笔记 / 周报"),
// else as is.
export function displayFolder(path, roots = []) {
  const dir = dirName(path)
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const nd = norm(dir)
  for (const root of roots) {
    const nr = norm(root)
    if (!nr) continue
    if (nd === nr) return baseName(root)
    if (nd.startsWith(nr + '/')) return `${baseName(root)}/${nd.slice(nr.length + 1)}`
  }
  return dir
}

export const localeOf = (lang) => (lang === 'zh' ? 'zh-CN' : 'en-US')

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Number((n / 1024 / 1024 / 1024).toFixed(2))} GB`
}

const startOfDay = (ms) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// 今天 / 昨天 / 10月27日 (with the year when it is not this year).
export function dayLabel(at, t, lang, now = Date.now()) {
  const day = startOfDay(at)
  const today = startOfDay(now)
  if (day === today) return t('history.today')
  if (day === startOfDay(today - 12 * 3600 * 1000)) return t('history.yesterday')
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  return new Date(at).toLocaleDateString(localeOf(lang), {
    year: sameYear ? undefined : 'numeric',
    month: lang === 'zh' ? 'long' : 'short',
    day: 'numeric'
  })
}

export const timeLabel = (at, lang) =>
  new Date(at).toLocaleTimeString(localeOf(lang), { hour: '2-digit', minute: '2-digit', hour12: false })

export const whenLabel = (at, t, lang) => `${dayLabel(at, t, lang)} ${timeLabel(at, lang)}`

// [{ label, items }] in the incoming (newest-first) order.
export function groupByDay(items, t, lang, now = Date.now()) {
  const groups = []
  for (const item of items) {
    const label = dayLabel(item.at, t, lang, now)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}

const splitLines = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n')

// Line diff of a stored version (old) against the current file (new):
// rows { type: 'same' | 'del' | 'add' | 'skip', text, count }. Unchanged runs
// keep `context` lines on each side of a change; the rest becomes one 'skip'.
export function diffRows(oldText, newText, context = 3) {
  const parts = diffComm(splitLines(oldText), splitLines(newText))
  const rows = []
  let changed = false
  parts.forEach((part, index) => {
    if (part.common) {
      const lines = part.common
      const head = index === 0 ? 0 : context
      const tail = index === parts.length - 1 ? 0 : context
      if (lines.length <= head + tail + 1) {
        for (const text of lines) rows.push({ type: 'same', text })
        return
      }
      for (const text of lines.slice(0, head)) rows.push({ type: 'same', text })
      rows.push({ type: 'skip', count: lines.length - head - tail })
      for (const text of lines.slice(lines.length - tail)) rows.push({ type: 'same', text })
      return
    }
    changed = true
    for (const text of part.buffer1 || []) rows.push({ type: 'del', text })
    for (const text of part.buffer2 || []) rows.push({ type: 'add', text })
  })
  return changed ? rows : []
}
