import { useEffect, useRef, useState } from 'react'
import { copyToClipboard } from '../ui.js'
import { Icon } from './icons.jsx'
import { AUTHOR_WECHAT, SYNC_REPORT_EVENT, issueUrl, osLabel } from '../lib/sync-diagnostics.js'

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''

// The sync error details (lib/sync-diagnostics.js), opened from the
// 查看详情 button of「检测到富文本与源码不一致」and the recovery-copy toasts.
// It asks the user to send them: GitHub (prefilled form) or WeChat (copy +
// the author's ID). The text itself is folded away; expanded, it is editable
// so the user can remove private content first. Every action uses that text.
export default function SyncReportDialog({ t }) {
  const [text, setText] = useState(null)
  const [status, setStatus] = useState('')
  const [expanded, setExpanded] = useState(false)
  const dialogRef = useRef(null)
  const areaRef = useRef(null)

  useEffect(() => {
    const onOpen = (event) => {
      let report = ''
      try {
        report = event.detail?.build?.() || ''
      } catch (error) {
        report = `详情生成失败：${error?.message || error}`
      }
      setStatus('')
      setExpanded(false)
      setText(report)
    }
    window.addEventListener(SYNC_REPORT_EVENT, onOpen)
    return () => window.removeEventListener(SYNC_REPORT_EVENT, onOpen)
  }, [])

  // Focus the dialog when it opens (Esc closes); the text box once expanded.
  useEffect(() => {
    if (text != null) dialogRef.current?.focus()
  }, [text == null])
  useEffect(() => {
    if (!expanded) return
    const area = areaRef.current
    if (!area) return
    area.focus()
    area.setSelectionRange(0, 0)
    area.scrollTop = 0
  }, [expanded])

  if (text == null) return null
  const close = () => setText(null)
  const lines = text.split('\n').length
  const openGithub = async () => {
    const { url, includesReport } = issueUrl({
      report: text,
      version: APP_VERSION,
      os: osLabel(window.api?.platform),
      title: t('syncReport.issueTitle'),
      pastePrompt: t('syncReport.pastePrompt')
    })
    if (!includesReport && !await copyToClipboard(text)) {
      setStatus(t('syncReport.copyFailed'))
      return
    }
    await window.api?.openExternal?.(url)
    setStatus(includesReport ? t('syncReport.githubOpened') : t('syncReport.githubPaste'))
  }
  const copyForWechat = async () => {
    setStatus(await copyToClipboard(text) ? t('syncReport.wechatCopied', { id: AUTHOR_WECHAT }) : t('syncReport.copyFailed'))
  }
  const copyId = async () => {
    setStatus(await copyToClipboard(AUTHOR_WECHAT) ? t('syncReport.idCopied') : t('syncReport.copyFailed'))
  }

  return (
    <>
      <div className="hm-sync-report-backdrop" onMouseDown={close} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="hm-sync-report"
        role="dialog"
        aria-modal="true"
        aria-label={t('syncReport.title')}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close() } }}
      >
        <button className="hm-sync-report-x" onClick={close} title={t('syncReport.close')} aria-label={t('syncReport.close')}>
          <Icon name="close" size={14} />
        </button>
        <div className="hm-sync-report-title">{t('syncReport.title')}</div>
        <p className="hm-sync-report-note">{t('syncReport.note')}</p>

        <div className="hm-sync-report-send">
          <div className="hm-sync-report-way">
            <span className="hm-sync-report-way-icon"><Icon name="github" size={17} /></span>
            <div className="hm-sync-report-way-text">
              <div className="hm-sync-report-way-name">{t('syncReport.githubName')}</div>
              <div className="hm-sync-report-way-desc">{t('syncReport.githubDesc')}</div>
            </div>
            <button className="hm-sync-report-btn primary" data-sync-report="github" onClick={openGithub}>{t('syncReport.github')}</button>
          </div>
          <div className="hm-sync-report-way">
            <span className="hm-sync-report-way-icon wechat"><Icon name="message" size={17} /></span>
            <div className="hm-sync-report-way-text">
              <div className="hm-sync-report-way-name">{t('syncReport.wechatName')}</div>
              <div className="hm-sync-report-way-desc">
                {t('syncReport.wechatDesc')}
                <button className="hm-sync-report-id" data-sync-report="copy-id" onClick={copyId} title={t('syncReport.copyId')}>
                  {AUTHOR_WECHAT}
                  <Icon name="copy" size={11} />
                </button>
              </div>
            </div>
            <button className="hm-sync-report-btn" data-sync-report="wechat" onClick={copyForWechat}>{t('syncReport.wechat')}</button>
          </div>
        </div>

        <button className={`hm-sync-report-toggle${expanded ? ' open' : ''}`} data-sync-report="toggle" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          <Icon name="chevron-right" size={13} />
          {t('syncReport.showContent', { lines })}
        </button>
        {expanded && (
          <textarea
            ref={areaRef}
            className="hm-sync-report-text"
            value={text}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
          />
        )}

        <div className={`hm-sync-report-status${status ? ' show' : ''}${status === t('syncReport.copyFailed') ? ' error' : ''}`} role="status">
          {status && status !== t('syncReport.copyFailed') && <Icon name="check" size={13} />}
          <span>{status}</span>
        </div>
      </div>
    </>
  )
}
