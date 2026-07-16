import { Icon } from '../icons.jsx'

export const SETTINGS_SECTIONS = [
  { id: 'general', labelKey: 'settings.general', icon: 'settings' },
  { id: 'editor', labelKey: 'settings.editor', icon: 'text-size' },
  { id: 'appearance', labelKey: 'settings.appearance', icon: 'sun' },
  { id: 'files', labelKey: 'settings.files', icon: 'folder' },
  { id: 'keyboard', labelKey: 'settings.keyboard', icon: 'command' },
  { id: 'about', labelKey: 'settings.about', icon: 'sparkle' }
]

export default function SettingsNav({ active, onChange, t }) {
  return (
    <nav className="settings-nav" aria-label={t('settings.pageTitle')}>
      {SETTINGS_SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          className={`settings-nav-item${section.id === active ? ' active' : ''}`}
          onClick={() => onChange(section.id)}
        >
          <Icon name={section.icon} size={15} />
          <span>{t(section.labelKey)}</span>
        </button>
      ))}
    </nav>
  )
}
