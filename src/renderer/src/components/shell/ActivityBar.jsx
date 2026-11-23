// Left activity bar: Home / Files / Outline / Search / Settings. Extracted
// from App.jsx (phase-2 refactor, US-7).
//
// Files / Outline / Search toggle like VS Code's activity bar (user report
// 2026-11-23): a click on the view that is showing hides the sidebar, any
// other click shows that view. The separate collapse button at the bottom
// went with it (VS Code has none; the toggle-sidebar shortcut stays). An icon
// is marked active only while its view is showing.
import { Icon } from '../icons.jsx'
import logoUrl from '../../assets/logo-small.png'

export default function ActivityBar({ home, sidebarMode, sidebarOpen, settingsActive, t, onHome, onFiles, onOutline, onSearch, onSettings, onToggleSidebar }) {
  const showing = (mode) => sidebarOpen && sidebarMode === mode
  const view = (mode, open) => () => (showing(mode) ? onToggleSidebar() : open())
  return (
    <div className="activity-bar">
      <button
        className={`activity-item activity-home${home ? ' active' : ''}`}
        title={t('nav.home')}
        onClick={onHome}
      >
        <img className="activity-logo" src={logoUrl} alt="HorseMD" />
      </button>
      <button
        className={`activity-item${showing('files') ? ' active' : ''}`}
        title={t('cmd.files')}
        onClick={view('files', onFiles)}
        aria-pressed={showing('files')}
      >
        <Icon name="folder" size={20} />
      </button>
      <button
        className={`activity-item${showing('outline') ? ' active' : ''}`}
        title={t('outline.title')}
        onClick={view('outline', onOutline)}
        aria-pressed={showing('outline')}
      >
        <Icon name="outline" size={20} />
      </button>
      <button
        className={`activity-item${showing('search') ? ' active' : ''}`}
        title={t('cmd.globalSearch')}
        onClick={view('search', onSearch)}
        aria-pressed={showing('search')}
      >
        <Icon name="search" size={20} />
      </button>
      <div className="activity-spacer" />
      <button
        className={`activity-item${settingsActive ? ' active' : ''}`}
        title={t('nav.settings')}
        onClick={onSettings}
      >
        <Icon name="gear" size={20} />
      </button>
    </div>
  )
}
