// Left activity bar: Home / Files / Outline / Search / collapse. Extracted
// verbatim in behavior from App.jsx (phase-2 refactor, US-7).
import { Icon } from '../icons.jsx'
import logoUrl from '../../assets/logo.png'

export default function ActivityBar({ home, sidebarMode, sidebarOpen, settingsActive, t, onHome, onFiles, onOutline, onSearch, onSettings, onToggleSidebar }) {
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
        className={`activity-item${sidebarMode === 'files' ? ' active' : ''}`}
        title={t('cmd.files')}
        onClick={onFiles}
      >
        <Icon name="folder" size={20} />
      </button>
      <button
        className={`activity-item${sidebarMode === 'outline' ? ' active' : ''}`}
        title={t('outline.title')}
        onClick={onOutline}
      >
        <Icon name="outline" size={20} />
      </button>
      <button
        className={`activity-item${sidebarMode === 'search' ? ' active' : ''}`}
        title={t('cmd.globalSearch')}
        onClick={onSearch}
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
      <button
        className="activity-item"
        title={sidebarOpen ? t('side.collapsePane') : t('side.expandPane')}
        onClick={onToggleSidebar}
      >
        <Icon name={sidebarOpen ? 'panel-left-close' : 'panel-left-open'} size={20} />
      </button>
    </div>
  )
}
