import os from 'node:os'

// Conflict copies, shared by the sync engine and the editor's save
// (docs/cloud-sync-review.md R1 / R3): "笔记 (冲突副本 MacBook 2026-10-29 1432).md".
// The device name and the time keep copies from several devices / rounds
// apart (a fixed "来自 HorseMD 的冲突副本" made the second conflict on a file
// collide with the first copy, and that device's sync failed from then on).

// The computer's host name, without ".local" and characters that cannot be
// in a file name.
export function deviceLabel(hostname = (() => { try { return os.hostname() } catch { return '' } })()) {
  const name = String(hostname || '').replace(/\.local$/i, '').replace(/[\\/:*?"<>|()\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  return name.slice(0, 40).trim() || 'HorseMD'
}

const pad2 = (n) => String(n).padStart(2, '0')
export function conflictStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}${pad2(date.getMinutes())}`
}

export const conflictSuffixFor = (deviceName = deviceLabel(), date = new Date()) => `冲突副本 ${deviceName} ${conflictStamp(date)}`

// "dir/stem (suffix).ext" with any path flavour (POSIX relative paths in the
// engine, native absolute paths in the editor).
export function conflictCopyName(path, suffix) {
  const value = String(path)
  const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  const dir = cut >= 0 ? value.slice(0, cut + 1) : ''
  const name = value.slice(cut + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return `${dir}${stem} (${suffix})${ext}`
}
