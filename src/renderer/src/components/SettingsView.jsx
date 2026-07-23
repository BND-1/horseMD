import { useI18n } from '../i18n.jsx'
import AboutSettings from './settings/AboutSettings.jsx'
import AppearanceSettings from './settings/AppearanceSettings.jsx'
import EditorSettings from './settings/EditorSettings.jsx'
import FilesSettings from './settings/FilesSettings.jsx'
import GeneralSettings from './settings/GeneralSettings.jsx'
import KeyboardSettings from './settings/KeyboardSettings.jsx'
import SettingsNav from './settings/SettingsNav.jsx'
import SyncSettings from './settings/SyncSettings.jsx'

export default function SettingsView({
  settings, onUpdateSettings, onHoverFont,
  activeSection, onActiveSectionChange,
  activeCssSnippetId, onActiveCssSnippetIdChange,
  theme, setTheme, customThemes = [], customTheme, onPickCustom,
  onOpenThemesFolder, onGetMoreThemes,
  lang, setLang,
  effectiveKeybindings,
  keybindingState,
  onSetKeybindings,
  onResetCommandKeybindings,
  onResetAllKeybindings,
  cloudSync,
  syncWorkspaces,
  folderRoots,
  onEnableSyncFolder,
  onAddSyncFolder,
  onRemoveSyncFolder
}) {
  const { t } = useI18n()
  const active = activeSection || 'editor'

  return (
    <div className="settings-page">
      <SettingsNav active={active} onChange={onActiveSectionChange} t={t} cloudSync={cloudSync} />
      <div className="settings-sections">
        {active === 'general' && (
          <GeneralSettings lang={lang} setLang={setLang} t={t} />
        )}
        {active === 'editor' && (
          <EditorSettings
            settings={settings}
            onUpdateSettings={onUpdateSettings}
            onHoverFont={onHoverFont}
            activeCssSnippetId={activeCssSnippetId}
            onActiveCssSnippetIdChange={onActiveCssSnippetIdChange}
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
        {active === 'sync' && cloudSync && (
          <SyncSettings
            folderRoots={folderRoots}
            registered={syncWorkspaces?.registered}
            connections={syncWorkspaces?.connections}
            busyRoot={syncWorkspaces?.busyRoot}
            loading={syncWorkspaces?.loading}
            onEnableFolder={onEnableSyncFolder}
            onAddSyncFolder={onAddSyncFolder}
            onRemoveFolder={onRemoveSyncFolder}
            onAddWebDavConnection={syncWorkspaces?.addWebDavConnection}
            onAddS3Connection={syncWorkspaces?.addS3Connection}
            onUpdateConnection={syncWorkspaces?.updateConnection}
            onRemoveConnection={syncWorkspaces?.removeConnection}
            onTestConnection={syncWorkspaces?.testConnection}
            onBindConnection={syncWorkspaces?.bindConnection}
            onPreview={syncWorkspaces?.preview}
            onListRemoteWorkspaces={syncWorkspaces?.listRemoteWorkspaces}
            onJoinWorkspace={syncWorkspaces?.joinWorkspace}
            onRun={syncWorkspaces?.run}
            t={t}
          />
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
