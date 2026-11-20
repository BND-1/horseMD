import { useI18n } from '../i18n.jsx'
import AboutSettings from './settings/AboutSettings.jsx'
import AppearanceSettings from './settings/AppearanceSettings.jsx'
import EditorSettings from './settings/EditorSettings.jsx'
import FilesSettings from './settings/FilesSettings.jsx'
import GeneralSettings from './settings/GeneralSettings.jsx'
import KeyboardSettings from './settings/KeyboardSettings.jsx'
import SettingsNav, { visibleSettingsSections } from './settings/SettingsNav.jsx'
import SyncSettings from './settings/SyncSettings.jsx'

export default function SettingsView({
  settings, onUpdateSettings, onHoverFont,
  activeSection, onActiveSectionChange,
  activeCssSnippetId, onActiveCssSnippetIdChange,
  theme, setTheme, customThemes = [], customTheme, onPickCustom,
  followsSystemTheme,
  onOpenThemesFolder, onGetMoreThemes,
  lang, setLang,
  effectiveKeybindings,
  keybindingState,
  onSetKeybindings,
  onResetCommandKeybindings,
  onResetAllKeybindings,
  globalShortcutStatus,
  cloudSync,
  syncAutoSave = false,
  syncWorkspaces,
  autoSync,
  folderRoots,
  onEnableSyncFolder,
  onAddSyncFolder,
  onRemoveSyncFolder,
  // Phones: the library folder, the only one that syncs (phase 1).
  syncLibraryRoot = null
}) {
  const { t } = useI18n()
  // A remembered section this device does not show (keyboard on a phone) opens the editor's.
  const requested = activeSection || 'editor'
  const active = visibleSettingsSections(cloudSync).some((section) => section.id === requested) ? requested : 'editor'

  return (
    <div className="settings-page">
      <SettingsNav active={active} onChange={onActiveSectionChange} t={t} cloudSync={cloudSync} />
      <div className="settings-sections">
        {active === 'general' && (
          <GeneralSettings
            lang={lang}
            setLang={setLang}
            settings={settings}
            onUpdateSettings={onUpdateSettings}
            syncAutoSave={syncAutoSave}
            t={t}
          />
        )}
        {active === 'editor' && (
          <EditorSettings
            settings={settings}
            onUpdateSettings={onUpdateSettings}
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
            settings={settings}
            onUpdateSettings={onUpdateSettings}
            followsSystemTheme={followsSystemTheme}
            onHoverFont={onHoverFont}
            activeCssSnippetId={activeCssSnippetId}
            onActiveCssSnippetIdChange={onActiveCssSnippetIdChange}
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
            progress={syncWorkspaces?.progress}
            onControlSync={syncWorkspaces?.controlSync}
            loading={syncWorkspaces?.loading}
            onEnableFolder={onEnableSyncFolder}
            onAddSyncFolder={onAddSyncFolder}
            libraryRoot={syncLibraryRoot}
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
            onUnlockEncryption={syncWorkspaces?.unlockEncryption}
            onChangeEncryptionPassword={syncWorkspaces?.changeEncryptionPassword}
            onStartOfficialLogin={syncWorkspaces?.startOfficialLogin}
            onAddOfficialConnection={syncWorkspaces?.addOfficialConnection}
            onOfficialAccount={syncWorkspaces?.officialAccount}
            onRun={syncWorkspaces?.run}
            autoSync={autoSync}
            settings={settings}
            onUpdateSettings={onUpdateSettings}
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
            globalShortcutStatus={globalShortcutStatus}
            t={t}
          />
        )}
        {active === 'about' && (
          <AboutSettings settings={settings} onUpdateSettings={onUpdateSettings} t={t} />
        )}
      </div>
    </div>
  )
}
