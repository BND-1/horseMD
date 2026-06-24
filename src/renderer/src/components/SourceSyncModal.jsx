import { useMemo } from 'react'
import { buildLineDiff, compactDiffRows } from '../diff.js'

export default function SourceSyncModal({ t, sync, busy, onConfirm, onClose }) {
  const toSource = sync?.direction === 'toSource'
  const fromContent = toSource ? sync?.sourceContent : sync?.localContent
  const toContent = toSource ? sync?.localContent : sync?.sourceContent
  const diff = useMemo(() => buildLineDiff(fromContent || '', toContent || ''), [fromContent, toContent])
  const rows = useMemo(() => compactDiffRows(diff.rows, 3), [diff.rows])
  const same = diff.added === 0 && diff.deleted === 0
  const title = toSource ? t('source.syncToSourceTitle') : t('source.syncTitle')
  const hint = toSource ? t('source.syncToSourceHint') : t('source.syncHint')
  const action = toSource ? t('source.applySyncToSource') : t('source.applySync')
  const noChanges = toSource ? t('source.noChangesToSource') : t('source.noChanges')

  return (
    <div className="hm-diff-modal source-sync-modal" role="dialog" aria-modal="true">
      <div className="hm-diff-head">
        <div>
          <div className="hm-diff-title">{title}</div>
          <div className="hm-diff-sub">
            {toSource
              ? `${sync?.source} ← ${sync?.name || sync?.rel}`
              : `${sync?.name || sync?.rel} ← ${sync?.source}`}
          </div>
        </div>
        <div className="source-sync-actions">
          <button onClick={onClose} disabled={busy}>{t('edit.cancel')}</button>
          <button className="primary" onClick={onConfirm} disabled={busy || same}>
            {busy ? t('source.syncing') : action}
          </button>
        </div>
      </div>
      <div className="source-sync-note">
        {same ? noChanges : hint}
      </div>
      <div className="hm-diff-body">
        {same ? (
          <div className="hm-diff-empty">{noChanges}</div>
        ) : (
          rows.map((r, i) => r.type === 'gap' ? (
            <div key={i} className="hm-diff-gap">...</div>
          ) : (
            <div key={i} className={`hm-diff-row ${r.type}`}>
              <span className="hm-diff-no">{r.oldLine ?? ''}</span>
              <span className="hm-diff-no">{r.newLine ?? ''}</span>
              <span className="hm-diff-mark">{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>
              <code>{r.text || ' '}</code>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
