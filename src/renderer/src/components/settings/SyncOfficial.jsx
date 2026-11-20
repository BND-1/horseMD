// HorseMD 同步 in 云同步 › 云端连接 (docs/official-sync-api.md): the first row
// of the service list, its email + code login (no password, Obsidian /
// Notion), and the account line under its connection: plan, usage, the
// account page on the website for buying and managing the subscription.
import { useEffect, useState } from 'react'
import { Icon } from '../icons.jsx'
import logo from '../../assets/logo-small.png'
import { errorMessage } from './SyncEncryption.jsx'

export const OFFICIAL_ACCOUNT_PAGE = 'https://horsemd.yangsir.net/account'
export const isOfficialConnection = (connection) => connection?.type === 'horsemd'

const formatBytes = (bytes) => {
  const value = Number(bytes) || 0
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(value >= 10 * 1024 ** 2 ? 0 : 1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

export function OfficialMark({ size = 'md' }) {
  return <span className={`sync-provider-mark logo official ${size}`} aria-hidden="true">
    <img src={logo} alt="" draggable="false" />
  </span>
}

export function OfficialRow({ onPick, t }) {
  return <button type="button" className="sync-provider-row official" data-provider="horsemd" onClick={onPick}>
    <OfficialMark />
    <span className="sync-provider-row-copy">
      <strong>{t('synco.name')}</strong>
      <small>{t('synco.desc')}</small>
    </span>
    <span className="sync-protocol-badge official">{t('synco.badge')}</span>
    <Icon name="chevron-right" size={15} className="sync-provider-row-arrow" />
  </button>
}

const openAccountPage = () => window.api?.openExternal?.(OFFICIAL_ACCOUNT_PAGE)

// Email → 发送验证码 → the 6 digits → 登录. A code can be asked again after
// the countdown the service gives (rate-limited).
export function OfficialLoginForm({ onStart, onVerify, onCancel, t }) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [wait, setWait] = useState(0)
  useEffect(() => {
    if (wait <= 0) return undefined
    const timer = setTimeout(() => setWait((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [wait])

  const explain = (cause) => {
    const text = errorMessage(cause)
    const retry = /(\d+)\s*秒/.exec(text)
    if (retry) setWait(Number(retry[1]))
    setError(text)
  }
  const send = async () => {
    if (busy || wait > 0) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError(t('synco.err.email'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await onStart({ email: email.trim() })
      setSent(true)
      setWait(60)
    } catch (cause) {
      explain(cause)
    } finally {
      setBusy(false)
    }
  }
  const verify = async (event) => {
    event.preventDefault()
    if (!sent) return send()
    if (busy) return
    if (!/^\d{6}$/.test(code.trim())) {
      setError(t('synco.err.code'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await onVerify({ email: email.trim(), code: code.trim() })
    } catch (cause) {
      explain(cause)
      setBusy(false)
    }
  }
  return <form className="sync-provider-form sync-official-login" onSubmit={verify} data-provider="horsemd">
    <ul className="sync-official-points">
      <li><Icon name="lock" size={13} />{t('synco.point.e2ee')}</li>
      <li><Icon name="cloud" size={13} />{t('synco.point.noSetup')}</li>
      <li><Icon name="refresh" size={13} />{t('synco.point.devices')}</li>
    </ul>
    <div className="sync-provider-fields">
      <label className="sync-field" htmlFor="synco-email">
        <span className="sync-field-label">{t('synco.email')}</span>
        <span className="sync-official-email-row">
          <input
            id="synco-email"
            className="sync-input"
            type="email"
            autoComplete="email"
            spellCheck={false}
            placeholder={t('synco.emailPh')}
            value={email}
            disabled={busy && !sent}
            onChange={(event) => { setEmail(event.target.value); setError('') }}
          />
          <button type="button" className="settings-action-btn" data-synco-send disabled={busy || wait > 0} onClick={send}>
            {wait > 0 ? t('synco.resendIn', { seconds: wait }) : sent ? t('synco.resend') : t('synco.send')}
          </button>
        </span>
      </label>
      {sent && <label className="sync-field" htmlFor="synco-code">
        <span className="sync-field-label">{t('synco.code')}</span>
        <span className="sync-official-code-wrap">
          <input
            id="synco-code"
            className="sync-input sync-official-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            autoFocus
            value={code}
            onChange={(event) => { setCode(event.target.value.replace(/\D/g, '')); setError('') }}
          />
          <small className="sync-official-sent">{t('synco.sent', { email: email.trim() })}</small>
        </span>
      </label>}
    </div>
    {error && <div className="sync-provider-error" role="alert"><strong>{error}</strong></div>}
    <p className="sync-provider-note"><Icon name="info" size={13} />{t('synco.note')}</p>
    <div className="sync-provider-actions">
      <button className="sync-provider-full" type="button" onClick={openAccountPage}>{t('synco.plans')}</button>
      <span className="sync-provider-actions-spacer" />
      <button className="settings-action-btn" type="button" data-sync-cancel onClick={onCancel}>{t('sync.cancel')}</button>
      <button className="settings-action-btn primary" type="submit" data-synco-login disabled={busy || (sent && code.length !== 6)}>
        {busy && sent ? t('synco.loggingIn') : sent ? t('synco.login') : t('synco.send')}
      </button>
    </div>
  </form>
}

// Under the connection: plan, usage bar, and why it is read-only.
export function OfficialAccountSummary({ connection, onLoad, t }) {
  const [account, setAccount] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    onLoad?.(connection.id)
      .then((value) => { if (alive) setAccount(value) })
      .catch((cause) => { if (alive) setError(errorMessage(cause)) })
    return () => { alive = false }
  }, [connection.id, onLoad])
  if (error) return <div className="sync-official-account error" role="status">{error}</div>
  if (!account) return <div className="sync-official-account loading">{t('synco.loading')}</div>
  const { plan, usage, storage } = account
  const active = plan?.status === 'active' || plan?.status === 'past_due' || (plan?.status === 'canceled' && plan?.endsAt && Date.parse(plan.endsAt) > Date.now())
  const ratio = plan?.storageBytes ? Math.min(1, (usage?.bytes || 0) / plan.storageBytes) : 0
  const date = (value) => (value ? new Date(value).toLocaleDateString() : '')
  return <div className="sync-official-account" data-plan={plan?.id || 'none'}>
    <div className="sync-official-account-head">
      <strong>{active ? t(`synco.plan.${plan.id}`) : t('synco.plan.none')}</strong>
      {active && plan.renewsAt && plan.status !== 'canceled' && <span>{t('synco.renews', { date: date(plan.renewsAt) })}</span>}
      {active && plan.status === 'canceled' && <span>{t('synco.ends', { date: date(plan.endsAt) })}</span>}
      {plan?.status === 'past_due' && <span className="warn">{t('synco.pastDue')}</span>}
      <span className="sync-provider-actions-spacer" />
      <button type="button" className="sync-provider-link" onClick={openAccountPage}>
        {active ? t('synco.manage') : t('synco.subscribe')}
        <Icon name="external" size={13} />
      </button>
    </div>
    {active && <>
      <div className="sync-official-usage" role="meter" aria-valuemin={0} aria-valuemax={plan.storageBytes} aria-valuenow={usage?.bytes || 0} aria-label={t('synco.usage')}>
        <span style={{ width: `${Math.round(ratio * 100)}%` }} className={ratio >= 0.9 ? 'full' : ''} />
      </div>
      <small>{t('synco.usageLine', { used: formatBytes(usage?.bytes), total: formatBytes(plan.storageBytes), file: formatBytes(plan.fileBytes), days: plan.historyDays })}</small>
    </>}
    {storage?.reason && <small className="warn">{t(`synco.reason.${storage.reason}`)}</small>}
  </div>
}

