import { useEffect, useRef } from 'react'
import { Icon } from '../icons.jsx'

export const SETTINGS_SECTIONS = [
  { id: 'general', labelKey: 'settings.general', icon: 'settings' },
  { id: 'editor', labelKey: 'settings.editor', icon: 'text-size' },
  { id: 'appearance', labelKey: 'settings.appearance', icon: 'sun' },
  { id: 'files', labelKey: 'settings.files', icon: 'folder' },
  { id: 'sync', labelKey: 'settings.sync', icon: 'cloud' },
  { id: 'keyboard', labelKey: 'settings.keyboard', icon: 'command' },
  { id: 'about', labelKey: 'settings.about', icon: 'sparkle' }
]

// Sync only with cloud sync; keyboard shortcuts only where there is a keyboard
// (not on phones, #175).
export function visibleSettingsSections(cloudSync = false) {
  const caps = (typeof window !== 'undefined' && window.api?.capabilities) || {}
  return SETTINGS_SECTIONS.filter((section) =>
    (section.id !== 'sync' || cloudSync) && (section.id !== 'keyboard' || caps.keyboardShortcuts !== false)
  )
}

export default function SettingsNav({ active, onChange, t, cloudSync = false }) {
  const navRef = useRef(null)
  // On a phone the sections are a swipeable chip row: keep the current one
  // in view (关于 sat half off-screen when opened from elsewhere).
  useEffect(() => {
    navRef.current?.querySelector('.settings-nav-item.active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return (
    <nav ref={navRef} className="settings-nav" aria-label={t('settings.pageTitle')}>
      {visibleSettingsSections(cloudSync).map((section) => (
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
