// Global search panel (issue #120) — the third sidebar mode. Input at the
// top (space-separated keywords = AND across files), results grouped by file
// below; clicking (or Enter on) a match opens the file and lands the
// in-document FindBar on that occurrence (jump logic in useGlobalSearch).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './icons.jsx'

function Snippet({ text, ranges }) {
  const parts = []
  let pos = 0
  ranges.forEach((range, i) => {
    if (range.start > pos) parts.push(<span key={`t${i}`}>{text.slice(pos, range.start)}</span>)
    parts.push(<mark key={`m${i}`}>{text.slice(range.start, range.end)}</mark>)
    pos = range.end
  })
  if (pos < text.length) parts.push(<span key="tail">{text.slice(pos)}</span>)
  return parts
}

export default function GlobalSearchPanel({ query, onQuery, results, t, onJump, onAddFolder, hasRoots }) {
  const inputRef = useRef(null)
  const bodyRef = useRef(null)
  const [selected, setSelected] = useState(0)

  // Flatten (file, match) rows for keyboard navigation.
  const rows = useMemo(
    () => results.files.flatMap((file) => file.matches.map((match) => ({ file, match }))),
    [results.files]
  )

  useEffect(() => {
    setSelected(0)
  }, [results.files])

  useEffect(() => {
    if (bodyRef.current) {
      const row = bodyRef.current.querySelector(`[data-idx="${selected}"]`)
      row?.scrollIntoView({ block: 'nearest' })
    }
  }, [selected])

  const jumpSelected = (index) => {
    const row = rows[index]
    if (row) onJump(row.file, row.match)
  }

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!rows.length) return
      event.preventDefault()
      setSelected((prev) => {
        const next = event.key === 'ArrowDown' ? prev + 1 : prev - 1
        const clamped = Math.min(Math.max(next, 0), rows.length - 1)
        return clamped
      })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      jumpSelected(selected)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (query) onQuery('')
      else inputRef.current?.blur()
    }
  }

  const statusLine = () => {
    if (results.status === 'loading') return <div className="gsearch-status">{t('gsearch.searching')}</div>
    if (results.status === 'error') return <div className="gsearch-status gsearch-error">{t('gsearch.error')}</div>
    if (results.status === 'done') {
      if (!results.files.length) return <div className="gsearch-status">{t('gsearch.noResults')}</div>
      return (
        <div className="gsearch-status">
          {t('gsearch.summary', { files: results.files.length, matches: results.matchTotal })}
          {results.truncated ? <span className="gsearch-truncated"> · {t('gsearch.truncated')}</span> : null}
        </div>
      )
    }
    return <div className="gsearch-status gsearch-hint">{t('gsearch.hint')}</div>
  }

  let rowIdx = -1

  return (
    <div className="gsearch">
      <div className="gsearch-input-wrap">
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          className="gsearch-input"
          type="text"
          value={query}
          spellCheck={false}
          placeholder={t('gsearch.placeholder')}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {query ? (
          <button className="gsearch-clear" title={t('find.close')} onClick={() => onQuery('')}>
            <Icon name="close" size={13} />
          </button>
        ) : null}
      </div>

      {statusLine()}

      <div className="gsearch-body" ref={bodyRef}>
        {!hasRoots ? (
          <div className="gsearch-empty">
            <div>{t('gsearch.noWorkspace')}</div>
            <button className="gsearch-add-folder" onClick={onAddFolder}>
              <Icon name="folder-plus" size={14} />
              <span>{t('workspace.addFolder')}</span>
            </button>
          </div>
        ) : (
          results.files.map((file) => (
            <div key={file.path} className="gsearch-file">
              <button
                type="button"
                className="gsearch-file-head"
                title={file.path}
                onClick={() => onJump(file, file.matches[0])}
              >
                <span className="gsearch-fname">{file.name}</span>
                <span className="gsearch-fdir">{file.rel.slice(0, file.rel.length - file.name.length)}</span>
                <span className="gsearch-count">{file.matches.length}</span>
              </button>
              {file.matches.map((match) => {
                rowIdx += 1
                const idx = rowIdx
                return (
                  <button
                    type="button"
                    key={`${file.path}:${match.line}:${match.col}`}
                    data-idx={idx}
                    className={`gsearch-item${idx === selected ? ' active' : ''}`}
                    onClick={() => onJump(file, match)}
                    onMouseEnter={() => setSelected(idx)}
                  >
                    <span className="gsearch-lineno">{match.line}</span>
                    <span className="gsearch-line">
                      <Snippet text={match.text} ranges={match.ranges} />
                    </span>
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
