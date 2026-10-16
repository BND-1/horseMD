// Floating "Save" action button. Shows only when the active tab has unsaved
// changes, fixed at the bottom-right of the editor area — so unlike a status-bar
// button it never shifts with the file-path length. Save is also Ctrl/Cmd+S;
// this is the discoverable, mouse-friendly affordance.
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'
import { labelWithShortcut } from '../lib/commands/shortcut-labels.js'

export default function SaveFab({ visible, onSave, effectiveKeybindings }) {
  const { t } = useI18n()
  if (!visible) return null
  return (
    <button
      className="hm-save-fab"
      onClick={onSave}
      title={labelWithShortcut(t('tip.save'), 'file.save', effectiveKeybindings)}
      aria-label={t('status.save')}
    >
      <Icon name="save" size={16} />
      <span>{t('status.save')}</span>
    </button>
  )
}
