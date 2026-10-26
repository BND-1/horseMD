// In-document find/replace bar. Extracted verbatim in behavior from App.jsx
// (phase-2 refactor, US-7). Pure rendering — all behavior is passed in.
import { Icon } from '../icons.jsx'

export default function FindBar({
  find,
  findInputRef,
  replaceInputRef,
  t,
  onQuery,
  onReplaceText,
  onPrev,
  onNext,
  onClose,
  onReplace,
  onReplaceAll,
  readOnly = false
}) {
  return (
    <div className="findbar">
      <div className="findbar-row">
        <Icon name="search" size={14} />
        <input
          ref={findInputRef}
          value={find.query}
          placeholder={t('find.placeholder')}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onPrev(e.shiftKey) }
            if (e.key === 'Escape') onClose()
          }}
        />
        <span className="findbar-count">
          {find.query ? `${find.active}/${find.matches}` : ''}
        </span>
        <button title={t('find.prev')} onClick={() => onPrev(true)}>
          <Icon name="chevron-up" size={14} />
        </button>
        <button title={t('find.next')} onClick={() => onNext(false)}>
          <Icon name="chevron-down" size={14} />
        </button>
        <button title={t('find.close')} onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {/* Read-only documents (reading mode #163) can be searched, not edited. */}
      {!readOnly && (
      <div className="findbar-row">
        <Icon name="replace" size={14} />
        <input
          ref={replaceInputRef}
          value={find.replace}
          placeholder={t('find.replace.placeholder')}
          onChange={(e) => onReplaceText(e.target.value)}
          onKeyDown={(e) => {
            // Enter = replace this one; Shift+Enter = replace all.
            if (e.key === 'Enter') { e.preventDefault(); onReplace(e.shiftKey) }
            if (e.key === 'Escape') onClose()
          }}
        />
        <span className="findbar-spacer" />
        <button
          className="findbar-textbtn"
          title={t('find.replace')}
          disabled={!find.query}
          onClick={() => onReplace(false)}
        >
          {t('find.replace')}
        </button>
        <button
          className="findbar-textbtn"
          title={t('find.replaceAll')}
          disabled={!find.query}
          onClick={() => onReplace(true)}
        >
          {t('find.replaceAll')}
        </button>
      </div>
      )}
    </div>
  )
}
