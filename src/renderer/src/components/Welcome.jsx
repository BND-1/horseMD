import { Icon } from './icons.jsx'
import logoUrl from '../assets/logo.png'
import { getCommandShortcut } from '../lib/commands/shortcut-labels.js'

// App version, injected at build time from package.json (see electron.vite.config).
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''

function relTime(ts, lang, t) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('time.justNow')
  if (min < 60) return t('time.minutesAgo', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('time.hoursAgo', { n: hr })
  const days = Math.floor(hr / 24)
  if (days === 1) return t('time.yesterday')
  try {
    return new Date(ts).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric'
    })
  } catch {
    return ''
  }
}

// Welcome / empty-state screen: logo, version, quick actions, recent files.
function ShortcutHint({ commandId, label, effectiveKeybindings }) {
  const shortcut = getCommandShortcut(commandId, effectiveKeybindings)
  if (!shortcut) return null
  return <span><kbd>{shortcut}</kbd> {label}</span>
}

export default function Welcome({ t, lang, recents, onNew, onOpen, onOpenFolder, onOpenRecent, onRemoveRecent, effectiveKeybindings }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <img className="welcome-logo" src={logoUrl} alt="HorseMD" />
        <h1>
          HorseMD
          {APP_VERSION && <span className="welcome-version">v{APP_VERSION}</span>}
        </h1>
        <p className="welcome-tagline">{t('welcome.tagline')}</p>
        <div className="welcome-actions">
          <button className="btn-primary" onClick={onNew}>
            <Icon name="file-plus" size={16} /> {t('welcome.newFile')}
          </button>
          <button onClick={onOpen}>
            <Icon name="file" size={16} /> {t('welcome.openFile')}
          </button>
          <button onClick={onOpenFolder}>
            <Icon name="folder" size={16} /> {t('welcome.openFolder')}
          </button>
        </div>

        {recents && recents.length > 0 && (
          <div className="welcome-recents">
            <div className="welcome-recents-head">{t('welcome.recent')}</div>
            <div className="welcome-recents-list">
              {recents.map((r) => (
                <div key={r.path} className="recent-item" onClick={() => onOpenRecent(r.path)} title={r.path}>
                  <Icon name="file" size={16} className="recent-icon" />
                  <span className="recent-main">
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-path">{r.dir}</span>
                  </span>
                  <span className="recent-time">{relTime(r.openedAt, lang, t)}</span>
                  {onRemoveRecent && (
                    <button
                      className="recent-remove"
                      title={t('welcome.removeRecent')}
                      aria-label={t('welcome.removeRecent')}
                      // Stop the click so removing doesn't also open the file.
                      onClick={(e) => { e.stopPropagation(); onRemoveRecent(r.path) }}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="welcome-hints">
          <ShortcutHint commandId="view.commandPalette" label={t('hint.palette')} effectiveKeybindings={effectiveKeybindings} />
          <ShortcutHint commandId="view.toggleSidebar" label={t('hint.sidebar')} effectiveKeybindings={effectiveKeybindings} />
          <ShortcutHint commandId="file.new" label={t('hint.new')} effectiveKeybindings={effectiveKeybindings} />
          <ShortcutHint commandId="file.save" label={t('hint.save')} effectiveKeybindings={effectiveKeybindings} />
        </div>
      </div>
    </div>
  )
}
