import { useEffect, useMemo, useRef } from 'react'
import { Icon } from '../icons.jsx'
import Toggle from '../ui/Toggle.jsx'
import { USER_CSS_TEMPLATE } from './user-css-template.js'
import { normalizeUserCssSnippets } from '../../settings.js'

const createSnippet = () => ({
  id: globalThis.crypto?.randomUUID?.() || `snippet-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  name: '',
  enabled: true,
  css: ''
})

export default function UserCssSnippets({
  settings, onUpdateSettings,
  activeSnippetId, onActiveSnippetIdChange,
  t
}) {
  const snippets = useMemo(
    () => normalizeUserCssSnippets(settings.userCssSnippets, settings.userCss),
    [settings.userCssSnippets, settings.userCss]
  )
  const cssRef = useRef(null)
  const timerRef = useRef(null)
  const active = snippets.find((snippet) => snippet.id === activeSnippetId) || snippets[0]
  const activeId = active?.id
  const activeIndex = snippets.findIndex((snippet) => snippet.id === active?.id)

  useEffect(() => {
    if (activeId && activeId !== activeSnippetId) onActiveSnippetIdChange(activeId)
  }, [activeId, activeSnippetId, onActiveSnippetIdChange])
  useEffect(() => () => clearTimeout(timerRef.current), [])

  const update = (next) => onUpdateSettings({ userCssSnippets: next })
  const updateSnippet = (id, patch, source = snippets) => update(source.map((snippet) =>
    snippet.id === id ? { ...snippet, ...patch } : snippet
  ))
  const flushCss = () => {
    const value = cssRef.current?.value
    const next = active && typeof value === 'string' && value !== active.css
      ? snippets.map((snippet) => snippet.id === active.id ? { ...snippet, css: value } : snippet)
      : snippets
    if (next !== snippets) update(next)
    clearTimeout(timerRef.current)
    return next
  }
  const updateActiveSnippet = (patch) => {
    if (!active) return
    updateSnippet(active.id, patch, flushCss())
  }
  const selectSnippet = (id) => {
    flushCss()
    onActiveSnippetIdChange(id)
  }
  const addSnippet = () => {
    const current = flushCss()
    const snippet = createSnippet()
    update([...current, snippet])
    onActiveSnippetIdChange(snippet.id)
  }
  const removeSnippet = () => {
    if (!active || snippets.length === 1) return
    const next = flushCss().filter((snippet) => snippet.id !== active.id)
    update(next)
    onActiveSnippetIdChange(next[Math.max(0, activeIndex - 1)]?.id || null)
  }
  const moveActive = (direction) => {
    const target = activeIndex + direction
    if (target < 0 || target >= snippets.length) return
    const next = [...flushCss()]
    ;[next[activeIndex], next[target]] = [next[target], next[activeIndex]]
    update(next)
  }
  const insertTemplate = () => {
    if (!active) return
    const base = (cssRef.current?.value || '').trim()
    const next = base ? `${base}\n\n${USER_CSS_TEMPLATE}` : USER_CSS_TEMPLATE
    if (cssRef.current) cssRef.current.value = next
    updateSnippet(active.id, { css: next }, flushCss())
  }
  const clearCss = () => {
    if (!active) return
    if (cssRef.current) cssRef.current.value = ''
    updateSnippet(active.id, { css: '' }, flushCss())
  }

  return (
    <section className="settings-block">
      <div className="settings-section-heading">
        <div>
          <h2 className="settings-block-title">{t('settings.customCss')}</h2>
          <p className="settings-block-desc">{t('settings.customCssDesc')}</p>
        </div>
        <button
          type="button"
          className="settings-icon-action"
          title={t('settings.cssSnippetAdd')}
          aria-label={t('settings.cssSnippetAdd')}
          onClick={addSnippet}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
      <div className="settings-css-workspace">
        <div className="settings-css-snippet-list" role="list" aria-label={t('settings.customCss')}>
          {snippets.map((snippet) => (
            <div className={`settings-css-snippet${snippet.id === active?.id ? ' active' : ''}`} key={snippet.id} role="listitem">
              <button
                type="button"
                className="settings-css-snippet-select"
                onClick={() => selectSnippet(snippet.id)}
                title={snippet.name || t('settings.cssSnippetUntitled')}
              >
                <span className={`settings-css-snippet-dot${snippet.enabled ? '' : ' muted'}`} />
                <span>{snippet.name || t('settings.cssSnippetUntitled')}</span>
              </button>
              <Toggle
                checked={snippet.enabled}
                onChange={(enabled) => updateSnippet(snippet.id, { enabled }, flushCss())}
                label={t('settings.cssSnippetToggle', { name: snippet.name || t('settings.cssSnippetUntitled') })}
              />
            </div>
          ))}
        </div>
        {active && <div className="settings-css-snippet-editor">
          <div className="settings-css-editor-head">
            <input
              key={active.id}
              className="settings-css-name-input"
              defaultValue={active.name}
              maxLength={80}
              placeholder={t('settings.cssSnippetNamePlaceholder')}
              aria-label={t('settings.cssSnippetName')}
              onBlur={(event) => updateActiveSnippet({ name: event.target.value.trim() })}
            />
            <div className="settings-css-actions">
              <button type="button" className="settings-icon-action" title={t('settings.cssSnippetMoveUp')} aria-label={t('settings.cssSnippetMoveUp')} disabled={activeIndex <= 0} onClick={() => moveActive(-1)}><Icon name="chevron-up" size={16} /></button>
              <button type="button" className="settings-icon-action" title={t('settings.cssSnippetMoveDown')} aria-label={t('settings.cssSnippetMoveDown')} disabled={activeIndex >= snippets.length - 1} onClick={() => moveActive(1)}><Icon name="chevron-down" size={16} /></button>
              <button type="button" className="settings-icon-action" title={t('settings.customCssTemplate')} aria-label={t('settings.customCssTemplate')} onClick={insertTemplate}><Icon name="code" size={16} /></button>
              <button type="button" className="settings-icon-action" title={t('settings.customCssClear')} aria-label={t('settings.customCssClear')} disabled={!active.css} onClick={clearCss}><Icon name="close" size={16} /></button>
              <button type="button" className="settings-icon-action danger" title={t('settings.cssSnippetRemove')} aria-label={t('settings.cssSnippetRemove')} disabled={snippets.length === 1} onClick={removeSnippet}><Icon name="trash" size={16} /></button>
            </div>
          </div>
          <textarea
            ref={cssRef}
            key={active.id}
            className="settings-css-editor"
            defaultValue={active.css}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={t('settings.customCssPlaceholder')}
            onChange={(event) => {
              const value = event.target.value
              clearTimeout(timerRef.current)
              timerRef.current = setTimeout(() => updateSnippet(active.id, { css: value }), 300)
            }}
            onBlur={flushCss}
          />
          <div className="settings-css-foot">
            <code>.milkdown .ProseMirror</code>
            {window.api?.capabilities?.devtools && window.api?.windowToggleDevTools && <button type="button" className="settings-link-btn" onClick={() => window.api.windowToggleDevTools()}>{t('settings.cssSnippetInspect')}</button>}
          </div>
        </div>}
      </div>
    </section>
  )
}
