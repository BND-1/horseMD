import { Icon } from './icons.jsx'

// Notify-only "new version available" toast — slides in at the bottom-right.
export default function UpdateToast({ t, latest, current, onDownload, onDismiss }) {
  return (
    <div className="update-toast" role="alert">
      <button className="update-toast-close" onClick={onDismiss} title={t('update.later')}>
        <Icon name="close" size={13} />
      </button>
      <div className="update-toast-head">
        <span className="update-toast-icon">
          <Icon name="sparkle" size={18} />
        </span>
        <div className="update-toast-text">
          <div className="update-toast-title">{t('update.title')}</div>
          <div className="update-toast-sub">
            v{current} <span className="update-toast-arrow">→</span> <b>v{latest}</b>
          </div>
        </div>
      </div>
      <button className="update-toast-primary" onClick={onDownload}>
        {t('update.download')}
      </button>
    </div>
  )
}
