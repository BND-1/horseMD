import { Icon } from '../icons.jsx'
import './pandoc-export.css'

export default function PandocExportStatus({ state, onDismiss, onInstall, t }) {
  if (!state) return null
  return (
    <div className="hm-pandoc-status" role="dialog" aria-modal="true" aria-labelledby="hm-pandoc-title">
      <div className="hm-pandoc-status-dialog">
        <div className={`hm-pandoc-status-icon ${state.status}`}><Icon name={state.status === 'success' ? 'check' : state.status === 'error' ? 'info' : 'refresh'} size={20} /></div>
        <div className="hm-pandoc-status-copy">
          <h2 id="hm-pandoc-title">{t(`pandoc.status.${state.status}`)}</h2>
          <p>{state.status === 'running' ? t('pandoc.runningHelp') : state.status === 'success' ? t('pandoc.successHelp', { path: state.path }) : state.error}</p>
          {state.status === 'success' && state.warning && <p className="warning">{t('pandoc.successWarning', { msg: state.warning })}</p>}
        </div>
        {state.status === 'error' && state.code === 'not-installed' && <button type="button" onClick={onInstall}>{t('pandoc.install')}</button>}
        {state.status !== 'running' && <button type="button" onClick={onDismiss}>{t('find.close')}</button>}
      </div>
    </div>
  )
}
