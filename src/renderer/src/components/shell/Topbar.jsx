// Top bar: mobile menu button, tab strip, new/split/palette buttons,
// and the Windows window controls. Extracted verbatim in behavior from App.jsx
// (phase-2 refactor, US-7).
import Tabs from '../Tabs.jsx'
import { Icon } from '../icons.jsx'
import WindowControls from '../WindowControls.jsx'
import { labelWithShortcut } from '../../lib/commands/shortcut-labels.js'

export default function Topbar({
  isMobile,
  readOnly,
  docActive = true,
  t,
  tabs,
  activeId,
  splitId,
  focusedPane,
  split,
  effectiveKeybindings,
  onActivate,
  onClose,
  onNew,
  onCloseOthers,
  onOpenRight,
  onRename,
  onDuplicate,
  onDelete,
  onExportPdf,
  onExportHtml,
  onExportPandoc,
  onShowHistory,
  onReorder,
  onToggleSidebar,
  onToggleReadOnly,
  onToggleImmersive,
  onToggleSplit,
  onOpenPalette,
  // Multi-window (tab tear-off), see Tabs.jsx.
  onBuildTransfer,
  onTransferred,
  onMoveToNewWindow,
  onMoveToMain,
  isSecondary = false
}) {
  return (
    <div className="topbar">
      {isMobile && !isSecondary && (
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
        onOpenRight={onOpenRight}
        onRename={onRename}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onExportPdf={onExportPdf}
        onExportHtml={onExportHtml}
        onExportPandoc={onExportPandoc}
        onShowHistory={onShowHistory}
        onReorder={onReorder}
        effectiveKeybindings={effectiveKeybindings}
        onBuildTransfer={onBuildTransfer}
        onTransferred={onTransferred}
        onMoveToNewWindow={onMoveToNewWindow}
        onMoveToMain={onMoveToMain}
        isSecondary={isSecondary}
      />
      <div className="topbar-spacer" />
      {/* The lock is about the open document: not on Home or Settings. */}
      {isMobile && docActive && (
        <button
          className={`icon-btn drag-no hm-readonly-btn${readOnly ? ' active' : ''}`}
          title={readOnly ? t('mobile.readOnlyOff') : t('mobile.readOnlyOn')}
          aria-pressed={readOnly}
          onClick={onToggleReadOnly}
        >
          <Icon name={readOnly ? 'lock' : 'unlock'} size={18} />
        </button>
      )}
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
      {onToggleImmersive && (
        <button
          className="icon-btn drag-no hm-immersive-btn"
          title={labelWithShortcut(t('cmd.immersive'), 'view.immersive', effectiveKeybindings)}
          aria-label={t('cmd.immersive')}
          onClick={onToggleImmersive}
        >
          <Icon name="expand" size={16} />
        </button>
      )}
      <button
        className="icon-btn drag-no"
        title={labelWithShortcut(t('cmd.palette'), 'view.commandPalette', effectiveKeybindings)}
        onClick={onOpenPalette}
      >
        {/* ⌘ means nothing on a phone; there the palette is "search files and commands". */}
        <Icon name={isMobile ? 'search' : 'command'} size={isMobile ? 18 : 16} />
      </button>
      {(window.api.platform === 'win32' || window.api.platform === 'linux') && <WindowControls t={t} />}
    </div>
  )
}
