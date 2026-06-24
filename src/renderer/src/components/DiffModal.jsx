import { useMemo } from 'react'
import { buildLineDiff, compactDiffRows } from '../diff.js'
import { Icon } from './icons.jsx'

export default function DiffModal({ t, tab, onClose }) {
  const diff = useMemo(() => buildLineDiff(tab?.savedContent || '', tab?.content || ''), [tab])
  const rows = useMemo(() => compactDiffRows(diff.rows, 3), [diff.rows])
  return (
    <>
      <div className="menu-backdrop" onMouseDown={onClose} />
      <div className="hm-diff-modal" role="dialog" aria-modal="true">
        <div className="hm-diff-head">
          <div>
            <div className="hm-diff-title">{t('diff.title')}</div>
            <div className="hm-diff-sub">
              +{diff.added} / -{diff.deleted} · {tab?.title || t('tab.untitled')}
            </div>
          </div>
          <button className="icon-btn" title={t('tip.close')} onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="hm-diff-body">
          {diff.added === 0 && diff.deleted === 0 ? (
            <div className="hm-diff-empty">{t('diff.empty')}</div>
          ) : (
            rows.map((r, i) =>
              r.type === 'gap' ? (
                <div key={i} className="hm-diff-gap">...</div>
              ) : (
                <div key={i} className={`hm-diff-row ${r.type}`}>
                  <span className="hm-diff-no">{r.oldLine ?? ''}</span>
                  <span className="hm-diff-no">{r.newLine ?? ''}</span>
                  <span className="hm-diff-mark">{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>
                  <code>{r.text || ' '}</code>
                </div>
              )
            )
          )}
        </div>
      </div>
    </>
  )
}
