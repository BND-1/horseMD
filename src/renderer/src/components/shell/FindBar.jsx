// In-document find/replace bar. Extracted verbatim in behavior from App.jsx
// (phase-2 refactor, US-7). Pure rendering — all behavior is passed in.
//
// Match options render as VSCode-style toggles (Aa / ab / .* / selection).
// Both inputs are <textarea>s so queries and replacements can be multiline
// (Ctrl/Cmd+Enter inserts a line break; Enter still steps matches). Enter
// during IME composition is ignored — it commits the composition, not the bar.
import { Icon } from '../icons.jsx'

const textareaRows = (value) => Math.min(5, (String(value).match(/\n/g) || []).length + 1)

const insertLineBreak = (e, value, onValue) => {
  const { selectionStart, selectionEnd } = e.target
  const next = `${value.slice(0, selectionStart)}\n${value.slice(selectionEnd)}`
  onValue(next)
  requestAnimationFrame(() => {
    const caret = selectionStart + 1
    e.target.setSelectionRange(caret, caret)
  })
}

export default function FindBar({
  find,
  findInputRef,
  replaceInputRef,
  t,
  onQuery,
  onReplaceText,
  onToggleOption,
  onPrev,
  onNext,
  onClose,
  onReplace,
  onReplaceAll
}) {
  const handleFindKey = (e) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      insertLineBreak(e, find.query, onQuery)
      return
    }
    if (e.key === 'Enter') { e.preventDefault(); onPrev(e.shiftKey) }
    if (e.key === 'Escape') onClose()
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const map = { c: 'matchCase', w: 'wholeWord', r: 'regex', l: 'inSelection' }
      const option = map[e.key.toLowerCase()]
      if (option) { e.preventDefault(); onToggleOption(option) }
    }
  }
  const handleReplaceKey = (e) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      insertLineBreak(e, find.replace, onReplaceText)
      return
    }
    // Enter = replace this one; Shift+Enter = replace all.
    if (e.key === 'Enter') { e.preventDefault(); onReplace(e.shiftKey) }
    if (e.key === 'Escape') onClose()
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const map = { c: 'matchCase', w: 'wholeWord', r: 'regex', l: 'inSelection' }
      const option = map[e.key.toLowerCase()]
      if (option) { e.preventDefault(); onToggleOption(option) }
    }
  }
  const toggles = [
    { key: 'matchCase', label: 'Aa', title: `${t('find.matchCase')} (Alt+C)` },
    { key: 'wholeWord', label: 'ab', title: `${t('find.wholeWord')} (Alt+W)`, disabled: find.regex },
    { key: 'regex', label: '.*', title: `${t('find.regex')} (Alt+R)`, disabled: false },
    { key: 'inSelection', icon: 'find-selection', title: `${t('find.inSelection')} (Alt+L)` }
  ]
  return (
    <div className="findbar">
      <div className="findbar-row">
        <Icon name="search" size={14} />
        <textarea
          ref={findInputRef}
          className={find.regexError ? 'findbar-input-invalid' : ''}
          rows={textareaRows(find.query)}
          value={find.query}
          placeholder={t('find.placeholder')}
          title={find.regexError ? t('find.regexInvalid') : undefined}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={handleFindKey}
        />
        {toggles.map((toggle) => (
          <button
            key={toggle.key}
            className="findbar-toggle"
            aria-pressed={!!find[toggle.key]}
            title={toggle.title}
            disabled={toggle.disabled && !find[toggle.key]}
            onClick={() => onToggleOption(toggle.key)}
          >
            {toggle.icon ? <Icon name={toggle.icon} size={14} /> : toggle.label}
          </button>
        ))}
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
      <div className="findbar-row">
        <Icon name="replace" size={14} />
        <textarea
          ref={replaceInputRef}
          rows={textareaRows(find.replace)}
          value={find.replace}
          placeholder={t('find.replace.placeholder')}
          onChange={(e) => onReplaceText(e.target.value)}
          onKeyDown={handleReplaceKey}
        />
        <span className="findbar-spacer" />
        <button
          className="findbar-textbtn"
          title={t('find.replace')}
          disabled={!find.query || find.regexError}
          onClick={() => onReplace(false)}
        >
          {t('find.replace')}
        </button>
        <button
          className="findbar-textbtn"
          title={t('find.replaceAll')}
          disabled={!find.query || find.regexError}
          onClick={() => onReplace(true)}
        >
          {t('find.replaceAll')}
        </button>
      </div>
    </div>
  )
}
