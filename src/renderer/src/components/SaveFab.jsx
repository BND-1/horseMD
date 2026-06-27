// Floating "Save" action button. Shows only when the active tab has unsaved
// changes, fixed at the bottom-right of the editor area — so unlike a status-bar
// button it never shifts with the file-path length. Save is also Ctrl/Cmd+S;
// this is the discoverable, mouse-friendly affordance.
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'

export default function SaveFab({ visible, onSave }) {
  const { t } = useI18n()
  if (!visible) return null
  return (
    <button className="hm-save-fab" onClick={onSave} title={t('tip.save')} aria-label={t('status.save')}>
      <Icon name="save" size={16} />
      <span>{t('status.save')}</span>
    </button>
  )
}
