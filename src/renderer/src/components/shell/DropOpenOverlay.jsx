import { Icon } from '../icons.jsx'

export default function DropOpenOverlay({ t }) {
  return (
    <div className="hm-drop-open-overlay" aria-hidden="true">
      <div className="hm-drop-open-card">
        <span className="hm-drop-open-icon"><Icon name="upload" size={24} /></span>
        <strong>{t('dropOpen.title')}</strong>
        <span>{t('dropOpen.hint')}</span>
      </div>
    </div>
  )
}
