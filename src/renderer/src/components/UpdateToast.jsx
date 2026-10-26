import { Icon } from './icons.jsx'

// Render inline **bold** / `code` / [text](url) as React elements (no innerHTML → XSS-safe).
function renderInline(text) {
  const parts = []
  let rest = text
  let key = 0
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]+\)/
  let m
  while ((m = rest.match(re))) {
    if (m.index > 0) parts.push(rest.slice(0, m.index))
    if (m[1] != null) parts.push(<b key={key++}>{m[1]}</b>)
    else if (m[2] != null) parts.push(<code key={key++}>{m[2]}</code>)
    else parts.push(m[3]) // link → show its text only
    rest = rest.slice(m.index + m[0].length)
  }
  if (rest) parts.push(rest)
  return parts
}

// Lightweight Markdown → React for release notes (headings, bullets, paragraphs).
function renderNotes(md) {
  const out = []
  let list = []
  const flush = (k) => {
    if (list.length) {
      out.push(
        <ul className="update-notes-list" key={'ul' + k}>
          {list}
        </ul>
      )
      list = []
    }
  }
  ;(md || '').split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (!line) {
      flush(i)
      return
    }
    const h = line.match(/^#{1,6}\s+(.*)$/)
    const li = line.match(/^[-*]\s+(.*)$/)
    if (h) {
      flush(i)
      out.push(
        <div className="update-notes-h" key={i}>
          {renderInline(h[1])}
        </div>
      )
    } else if (li) {
      list.push(<li key={i}>{renderInline(li[1])}</li>)
    } else {
      flush(i)
      out.push(
        <div className="update-notes-p" key={i}>
          {renderInline(line)}
        </div>
      )
    }
  })
  flush('end')
  return out
}

const mb = (bytes) => `${(Math.max(0, bytes || 0) / 1048576).toFixed(bytes > 104857600 ? 0 : 1)} MB`

// "New version available" (#164): release notes, then either a direct
// download (progress, cancel → "restart and install", or the file opened /
// shown for the user) or the GitHub release page. `download` says whether
// this install can download directly (from update:check); `dl` is the main
// process download state (useUpdateDownload).
// Buttons say what happens: while downloading,「后台下载」(hide, keep
// downloading — the prompt returns when done) and「取消下载」(stop, delete the
// part); ready:「稍后」/「重启并安装」. The corner ✕ ("later") only shows when no
// button already offers that.
export default function UpdateToast({ t, latest, current, notes, download, dl = { status: 'idle' }, onDirect, onGitHub, onCancel, onInstall, onShowFile, onHide, onDismiss }) {
  const hasNotes = !!(notes && notes.trim())
  const status = dl.version && dl.version !== latest ? 'idle' : dl.status
  const total = dl.total || download?.size || 0
  const percent = total ? Math.min(100, Math.floor(((dl.received || 0) / total) * 100)) : 0
  const showClose = status !== 'downloading' && !(status === 'ready' && dl.mode === 'install')
  return (
    <div className="update-toast" role="alert">
      <div className="update-toast-head">
        <span className="update-toast-icon">
          <Icon name="sparkle" size={18} />
        </span>
        <div className="update-toast-text">
          <div className="update-toast-title">{t('update.title')}</div>
          <div className="update-toast-sub">
            <span className="update-ver-old">v{current}</span>
            <span className="update-ver-arrow">→</span>
            <span className="update-ver-new">v{latest}</span>
          </div>
        </div>
        {showClose && (
          <button className="update-toast-close" onClick={onDismiss} title={t('update.later')} aria-label={t('update.later')}>
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      {hasNotes && (
        <div className="update-toast-notes">
          <div className="update-toast-notes-label">{t('update.whatsNew')}</div>
          <div className="update-toast-notes-body">{renderNotes(notes)}</div>
        </div>
      )}
      {status === 'downloading' && (
        <div className="update-toast-progress">
          <div className="update-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className="update-progress-bar" style={{ width: `${percent}%` }} />
          </div>
          <div className="update-progress-text">
            <span>{t('update.downloading', { percent })}</span>
            <span>{total ? `${mb(dl.received)} / ${mb(total)}` : mb(dl.received)}</span>
          </div>
        </div>
      )}
      {status === 'ready' && (
        <div className="update-toast-done">
          <Icon name="check" size={14} />
          <span>{dl.mode === 'install' ? t('update.readyInstall') : dl.mode === 'open' ? t('update.readyOpen') : t('update.readyReveal')}</span>
        </div>
      )}
      {status === 'error' && <div className="update-toast-error">{dl.error || t('update.failed')}</div>}
      <div className="update-toast-foot">
        {status === 'downloading' && <>
          <button className="update-toast-secondary" onClick={onCancel}>{t('update.cancel')}</button>
          <button className="update-toast-primary" onClick={onHide}>{t('update.background')}</button>
        </>}
        {status === 'ready' && dl.mode === 'install' && <>
          <button className="update-toast-secondary" onClick={onHide}>{t('update.later')}</button>
          <button className="update-toast-primary" onClick={onInstall}>{t('update.restartInstall')}</button>
        </>}
        {status === 'ready' && dl.mode !== 'install' && (
          <button className="update-toast-primary" onClick={onShowFile}>{dl.mode === 'open' ? t('update.openAgain') : t('update.showFile')}</button>
        )}
        {(status === 'idle' || status === 'error') && <>
          <button className={download ? 'update-toast-secondary' : 'update-toast-primary'} onClick={onGitHub}>
            {download ? t('update.github') : t('update.download')}
          </button>
          {download && (
            <button className="update-toast-primary" onClick={onDirect}>
              {status === 'error' ? t('update.retry') : t('update.direct')}
              {status !== 'error' && download.size ? <span className="update-toast-size">{mb(download.size)}</span> : null}
            </button>
          )}
        </>}
      </div>
    </div>
  )
}
