import { useState } from 'react'
import { useI18n } from '../i18n.jsx'
import AboutSettings from './settings/AboutSettings.jsx'
import AppearanceSettings from './settings/AppearanceSettings.jsx'
import EditorSettings from './settings/EditorSettings.jsx'
import FilesSettings from './settings/FilesSettings.jsx'
import GeneralSettings from './settings/GeneralSettings.jsx'
import KeyboardSettings from './settings/KeyboardSettings.jsx'
import SettingsNav from './settings/SettingsNav.jsx'

export default function SettingsView({
  settings, onUpdateSettings, onHoverFont,
  theme, setTheme, customThemes = [], customTheme, onPickCustom,
  onOpenThemesFolder, onGetMoreThemes,
  lang, setLang,
  effectiveKeybindings,
  keybindingState,
  onSetKeybindings,
  onResetCommandKeybindings,
  onResetAllKeybindings
}) {
  const { t } = useI18n()
  const [active, setActive] = useState('editor')

  return (
    <div className="settings-page">
      <SettingsNav active={active} onChange={setActive} t={t} />
      <div className="settings-sections">
        {active === 'general' && (
          <GeneralSettings lang={lang} setLang={setLang} t={t} />
        )}
        {active === 'editor' && (
          <EditorSettings
            settings={settings}
            onUpdateSettings={onUpdateSettings}
            onHoverFont={onHoverFont}
            t={t}
          />
        )}
        {active === 'appearance' && (
          <AppearanceSettings
            theme={theme}
            setTheme={setTheme}
            customThemes={customThemes}
            customTheme={customTheme}
            onPickCustom={onPickCustom}
            onOpenThemesFolder={onOpenThemesFolder}
            onGetMoreThemes={onGetMoreThemes}
            lang={lang}
            t={t}
          />
        )}
        {active === 'files' && (
          <FilesSettings settings={settings} onUpdateSettings={onUpdateSettings} t={t} />
        )}
        {active === 'keyboard' && (
          <KeyboardSettings
            effectiveKeybindings={effectiveKeybindings}
            keybindingState={keybindingState}
            onSetKeybindings={onSetKeybindings}
            onResetCommand={onResetCommandKeybindings}
            onResetAll={onResetAllKeybindings}
            t={t}
          />
        )}
        {active === 'about' && (
          <AboutSettings t={t} />
        )}
      </div>
    </div>
  )
}
