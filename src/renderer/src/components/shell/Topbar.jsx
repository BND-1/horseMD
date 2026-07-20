// Top bar: mobile menu button, tab strip, new/split/image-host/palette buttons,
// and the Windows window controls. Extracted verbatim in behavior from App.jsx
// (phase-2 refactor, US-7).
import Tabs from '../Tabs.jsx'
import { Icon } from '../icons.jsx'
import ImageHostButton from '../ImageHostButton.jsx'
import WindowControls from '../WindowControls.jsx'
import { labelWithShortcut } from '../../lib/commands/shortcut-labels.js'

export default function Topbar({
  isMobile,
  t,
  tabs,
  activeId,
  splitId,
  focusedPane,
  split,
  imageUploadCommand,
  effectiveKeybindings,
  onActivate,
  onClose,
  onNew,
  onCloseOthers,
  onCloseRight,
  onOpenRight,
  onRename,
  onDuplicate,
  onDelete,
  onExportPdf,
  onReorder,
  onToggleSidebar,
  onToggleSplit,
  onImageHostChange,
  onOpenPalette
}) {
  return (
    <div className="topbar">
      {isMobile && (
        <button
          className="icon-btn drag-no hm-menu-btn"
          title={t('cmd.files')}
          onClick={onToggleSidebar}
        >
          <Icon name="menu" size={20} />
        </button>
      )}
      <Tabs
        tabs={tabs}
        activeId={activeId}
        splitId={splitId}
        focusedPane={focusedPane}
        onActivate={onActivate}
        onClose={onClose}
        onNew={onNew}
        onCloseOthers={onCloseOthers}
        onCloseRight={onCloseRight}
        onOpenRight={onOpenRight}
        onRename={onRename}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onExportPdf={onExportPdf}
        onReorder={onReorder}
        effectiveKeybindings={effectiveKeybindings}
      />
      <div className="topbar-spacer" />
      <button
        className="icon-btn drag-no"
        title={labelWithShortcut(t('welcome.newFile'), 'file.new', effectiveKeybindings)}
        onClick={onNew}
      >
        <Icon name="plus" size={18} />
      </button>
      {!isMobile && (
        <button
          className={`icon-btn drag-no${split ? ' active' : ''}`}
          title={split ? t('split.close') : t('split.toggle')}
          onClick={onToggleSplit}
        >
          <Icon name="columns" size={16} />
        </button>
      )}
      {!isMobile && (
        <ImageHostButton
          t={t}
          command={imageUploadCommand}
          onChange={onImageHostChange}
        />
      )}
      <button
        className="icon-btn drag-no"
        title={labelWithShortcut(t('cmd.palette'), 'view.commandPalette', effectiveKeybindings)}
        onClick={onOpenPalette}
      >
        <Icon name="command" size={16} />
      </button>
      {(window.api.platform === 'win32' || window.api.platform === 'linux') && <WindowControls t={t} />}
    </div>
  )
}
