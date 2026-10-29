import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'
import { THEMES, themeById } from '../themes.js'
import { LANGS } from '../i18n.jsx'
import { FONT_SIZE_MIN, FONT_SIZE_MAX } from '../settings.js'
import LayoutControl from './LayoutControl.jsx'
import { usePopover } from '../hooks/usePopover.js'
import { labelWithShortcut } from '../lib/commands/shortcut-labels.js'
import { isTabDirty } from '../lib/tab-state.js'
import { autoSyncText, keyOf as syncKey } from '../hooks/useAutoSync.js'

function stats(md) {
  const text = (md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[#>*_~\-\[\]()!]/g, ' ')
  const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length
  const chars = (md || '').length
  const charsNoSpace = (md || '').replace(/\s/g, '').length
  const readMin = Math.max(1, Math.round(words / 220))
  return { words, chars, charsNoSpace, readMin }
}

// Small popover that closes on outside click.
// usePopover is imported from ../hooks (shared with LayoutControl).


// Document stats: one status-bar button showing the character count → popover
// with the full breakdown (words, characters, characters w/o spaces, read time).
function StatsControl({ stats }) {
  const { t } = useI18n()
  const { open, setOpen, ref } = usePopover()
  const n = (x) => x.toLocaleString()
  const rows = [
    [t('status.statWords'), n(stats.words)],
    [t('status.statChars'), n(stats.chars)],
    [t('status.statCharsNoSpace'), n(stats.charsNoSpace)],
    [t('status.statRead'), t('status.readValue', { n: stats.readMin })]
  ]
  return (
    <div className="block-switch hm-stats" ref={ref}>
      <button className="status-btn" onClick={() => setOpen((v) => !v)} title={t('status.stats')}>
        <Icon name="stats" size={14} /> {t('status.chars', { n: n(stats.chars) })}
      </button>
      {open && (
        <div className="hm-pop hm-stats-pop">
          {rows.map(([label, value]) => (
            <div className="hm-stat-row" key={label}>
              <span className="hm-stat-label">{label}</span>
              <span className="hm-stat-value">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Cloud sync at a glance (Obsidian / Dropbox style): shown while at least one
// folder is bound to the cloud. 同步中… / 已同步 14:32 / 需要确认 / 同步出错 /
// 自动同步已关闭; the tooltip has each folder's last result; a click opens
// Settings › 云同步.
function SyncStatusItem({ sync, autoSync, syncAuto, onOpen }) {
  const { t } = useI18n()
  const bound = (sync?.registered || []).filter((entry) => entry.connectionId)
  if (!sync?.supported || !bound.length) return null
  const byFolder = autoSync?.byFolder || {}
  const results = bound.map((entry) => byFolder[syncKey(entry.rootPath)]).filter(Boolean)
  const lastAt = Math.max(0, ...results.filter((r) => r.kind === 'done' || r.kind === 'idle').map((r) => r.at))
  let state = 'ok'
  let text = lastAt
    ? t('status.sync.done', { time: new Date(lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
    : t('status.sync.ready')
  if (sync.busyRoot) {
    state = 'busy'
    text = sync.progress?.waiting ? t('status.sync.waiting') : t('status.sync.busy')
  } else if (results.some((r) => r.kind === 'confirm')) {
    state = 'confirm'
    text = t('status.sync.confirm')
  } else if (results.some((r) => r.kind === 'error')) {
    state = 'error'
    text = t('status.sync.error')
  } else if (syncAuto === false) {
    state = 'off'
    text = t('status.sync.off')
  }
  const title = [
    ...bound.map((entry) => {
      const name = entry.name || String(entry.rootPath).split(/[\\/]/).filter(Boolean).pop()
      return `${name}: ${autoSyncText(byFolder[syncKey(entry.rootPath)], t) || t('status.sync.never')}`
    }),
    t('status.sync.open')
  ].join('\n')
  return (
    <button className={`status-btn hm-sync-status ${state}`} onClick={onOpen} title={title}>
      <Icon name={state === 'busy' ? 'refresh' : 'cloud'} size={14} /> {text}
    </button>
  )
}

function ThemePicker({
  theme,
  setTheme,
  customThemes = [],
  customTheme,
  onPickCustom,
  onRefreshThemes,
  onOpenThemesFolder,
  onGetMoreThemes
}) {
  const { lang, t } = useI18n()
  const { open, setOpen, ref } = usePopover()
  const cur = themeById(theme)
  // Re-scan the themes folder each time the menu opens so freshly-dropped CSS
  // files show up without a restart.
  const toggle = () => {
    if (!open) onRefreshThemes?.()
    setOpen((v) => !v)
  }
  const activeCustom = customThemes.find((c) => c.file === customTheme)
  const triggerLabel = activeCustom ? activeCustom.name : lang === 'zh' ? cur.zh : cur.en
  return (
    <div className="block-switch" ref={ref}>
      <button className="status-btn" onClick={toggle} title={t('tip.toggleTheme')}>
        <span className="theme-swatch" style={{ background: activeCustom ? 'var(--accent)' : cur.swatch }} />
        {triggerLabel}
        <span className="block-switch-caret">▾</span>
      </button>
      {open && (
        <div className="block-switch-menu theme-menu">
          {THEMES.map((th) => (
            <button
              key={th.id}
              className={`block-menu-item${!customTheme && th.id === theme ? ' active' : ''}`}
              onClick={() => {
                setTheme(th.id)
                setOpen(false)
              }}
            >
              <span className="theme-swatch" style={{ background: th.swatch }} />
              <span className="block-menu-name">{lang === 'zh' ? th.zh : th.en}</span>
            </button>
          ))}

          {customThemes.length > 0 && (
            <>
              <div className="theme-menu-label">{t('theme.custom')}</div>
              {customThemes.map((c) => (
                <button
                  key={c.file}
                  className={`block-menu-item${customTheme === c.file ? ' active' : ''}`}
                  onClick={() => {
                    onPickCustom?.(c.file)
                    setOpen(false)
                  }}
                  title={c.file}
                >
                  <span className="theme-swatch theme-swatch-custom" />
                  <span className="block-menu-name">
                    {c.name}
                    {c.dir ? <span className="theme-custom-dir"> · {c.dir}</span> : null}
                  </span>
                </button>
              ))}
            </>
          )}

          <div className="theme-menu-sep" />
          <button
            className="block-menu-item theme-menu-action"
            onClick={() => {
              onOpenThemesFolder?.()
              setOpen(false)
            }}
          >
            <Icon name="folder" size={13} />
            <span className="block-menu-name">{t('theme.openFolder')}</span>
          </button>
          <button
            className="block-menu-item theme-menu-action"
            onClick={() => {
              onGetMoreThemes?.()
              setOpen(false)
            }}
          >
            <Icon name="globe" size={13} />
            <span className="block-menu-name">{t('theme.getMore')}</span>
          </button>
        </div>
      )}
    </div>
  )
}

function LangSwitch({ lang, setLang }) {
  const { t } = useI18n()
  const { open, setOpen, ref } = usePopover()
  return (
    <div className="block-switch" ref={ref}>
      <button className="status-btn" onClick={() => setOpen((v) => !v)} title={t('tip.language')}>
        <Icon name="globe" size={14} /> {lang === 'zh' ? '中文' : 'EN'}
      </button>
      {open && (
        <div className="block-switch-menu">
          {LANGS.map((l) => (
            <button
              key={l.id}
              className={`block-menu-item${l.id === lang ? ' active' : ''}`}
              onClick={() => {
                setLang(l.id)
                setOpen(false)
              }}
            >
              <span className="block-menu-name">{l.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Mobile: a single "•••" popover that folds together the controls that crowd
// the bottom bar on a phone — word counts, source toggle, theme, language,
// GitHub — so the bar itself stays to just the block type + this one button.
function MobileMore({
  dirty,
  onSave,
  onSettings,
  sourceMode,
  onToggleSource,
  theme,
  setTheme,
  lang,
  setLang,
  customThemes = [],
  customTheme,
  onPickCustom,
  onRefreshThemes,
  fontSize,
  onSetFontSize
}) {
  const { t } = useI18n()
  const { open, setOpen, ref } = usePopover()
  const stepFont = (delta) =>
    onSetFontSize(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, fontSize + delta)))
  const toggle = () => {
    if (!open) onRefreshThemes?.()
    setOpen((v) => !v)
  }
  return (
    <div className="block-switch" ref={ref}>
      <button className="status-btn hm-more-btn" onClick={toggle} title={t('status.more')}>
        <Icon name="more" size={16} />
        <span>{t('status.more')}</span>
      </button>
      {open && (
        <div className="block-switch-menu hm-status-sheet">
          <button
            className={`block-menu-item hm-sheet-save${dirty ? ' dirty' : ''}`}
            disabled={!dirty}
            onClick={() => {
              if (!dirty) return
              onSave?.()
              setOpen(false)
            }}
          >
            <Icon name="save" size={15} />
            <span className="block-menu-name">{t('status.save')}</span>
            {dirty && <span className="hm-sheet-save-dot" />}
          </button>
          <div className="theme-menu-sep" />
          <button
            className="block-menu-item"
            onClick={() => {
              onToggleSource()
              setOpen(false)
            }}
          >
            <Icon name="code" size={14} />
            <span className="block-menu-name">
              {sourceMode ? t('status.source') : t('status.rich')}
            </span>
          </button>

          <div className="theme-menu-label">{t('settings.fontSize')}</div>
          <div className="hm-sheet-fontsize">
            <button
              className="hm-fontstep"
              onClick={() => stepFont(-1)}
              disabled={fontSize <= FONT_SIZE_MIN}
              aria-label="−"
            >
              −
            </button>
            <span className="hm-fontstep-value">{fontSize}px</span>
            <button
              className="hm-fontstep"
              onClick={() => stepFont(1)}
              disabled={fontSize >= FONT_SIZE_MAX}
              aria-label="+"
            >
              +
            </button>
          </div>

          <div className="theme-menu-label">{t('tip.toggleTheme')}</div>
          <div className="hm-sheet-themes">
            {THEMES.map((th) => (
              <button
                key={th.id}
                className={`hm-sheet-swatch${!customTheme && th.id === theme ? ' active' : ''}`}
                style={{ background: th.swatch }}
                title={lang === 'zh' ? th.zh : th.en}
                onClick={() => setTheme(th.id)}
              />
            ))}
            {customThemes.map((c) => (
              <button
                key={c.file}
                className={`hm-sheet-swatch hm-sheet-swatch-custom${customTheme === c.file ? ' active' : ''}`}
                title={c.name}
                onClick={() => onPickCustom?.(c.file)}
              />
            ))}
          </div>

          <div className="theme-menu-label">{t('tip.language')}</div>
          <div className="hm-sheet-langs">
            {LANGS.map((l) => (
              <button
                key={l.id}
                className={`block-menu-item${l.id === lang ? ' active' : ''}`}
                onClick={() => setLang(l.id)}
              >
                <span className="block-menu-name">{l.label}</span>
              </button>
            ))}
          </div>

          <div className="theme-menu-sep" />
          <button
            className="block-menu-item theme-menu-action"
            onClick={() => {
              onSettings?.()
              setOpen(false)
            }}
          >
            <Icon name="gear" size={14} />
            <span className="block-menu-name">{t('nav.settings')}</span>
          </button>
          <button
            className="block-menu-item theme-menu-action"
            onClick={() => {
              window.api.openExternal('https://github.com/BND-1/horseMD')
              setOpen(false)
            }}
          >
            <Icon name="github" size={13} />
            <span className="block-menu-name">GitHub</span>
          </button>
        </div>
      )}
    </div>
  )
}

export default function StatusBar({
  tab,
  isMobile,
  onSave,
  onShare,
  onSettings,
  sync,
  autoSync,
  syncAuto,
  onOpenSync,
  theme,
  setTheme,
  lang,
  setLang,
  effectiveKeybindings,
  sourceMode,
  onToggleSource,
  readingMode,
  onToggleReadingMode,
  pageWidth,
  onSetPageWidth,
  fontSize,
  onSetFontSize,
  lineHeight,
  onSetLineHeight,
  paragraphSpacing,
  onSetParagraphSpacing,
  headingSpacing,
  onSetHeadingSpacing,
  customThemes,
  customTheme,
  onPickCustom,
  onRefreshThemes,
  onOpenThemesFolder,
  onGetMoreThemes
}) {
  const { t } = useI18n()
  // Debounce the (O(n) over the whole document) stats compute: recompute
  // ~400ms after typing pauses instead of on every keystroke. On large docs the
  // per-keystroke regex sweep was a real typing-lag source, especially on
  // Windows. Update immediately on tab switch (different id) so the count tracks
  // the active doc without the debounce delay; a trailing fire after the last
  // edit keeps the final value correct.
  // The count runs when the main thread is idle (a timer task could land in
  // the middle of typing: ~15–25 ms per run on Windows for a 250 K-char
  // document), and is cached per tab, so switching back to an unchanged tab
  // shows it at once instead of recomputing inside the click.
  const cacheRef = useRef(new Map())
  const statsFor = (id, content) => {
    const hit = cacheRef.current.get(id)
    if (hit && hit.content === content) return hit.stats
    const next = stats(content)
    cacheRef.current.set(id, { content, stats: next })
    return next
  }
  const [s, setS] = useState(() => statsFor(tab?.id, tab?.content))
  const lastTabId = useRef(tab?.id)
  useEffect(() => {
    const id = tab?.id
    const content = tab?.content
    const switched = lastTabId.current !== id
    lastTabId.current = id
    const hit = cacheRef.current.get(id)
    if (hit && hit.content === content) {
      setS(hit.stats)
      return
    }
    const run = () => setS(statsFor(id, content))
    const idle = typeof window.requestIdleCallback === 'function'
    let idleHandle = 0
    const whenIdle = () => {
      if (idle) idleHandle = window.requestIdleCallback(run, { timeout: 1000 })
      else run()
    }
    // A switched-to tab updates soon; an edit waits for the typing pause.
    const timer = setTimeout(whenIdle, switched ? 0 : 400)
    return () => {
      clearTimeout(timer)
      if (idleHandle) window.cancelIdleCallback(idleHandle)
    }
  }, [tab?.id, tab?.content])
  const dirty = isTabDirty(tab)
  return (
    <div className="statusbar">
      <div className="status-left">
        {tab ? (
          isMobile ? (
            <>
              <span className={`status-dot ${dirty ? 'mod' : 'ok'}`}>{dirty ? '●' : '✓'}</span>
              <span className="status-counts">
                {t('status.words', { n: s.words })} · {t('status.chars', { n: s.chars })} ·{' '}
                {t('status.read', { n: s.readMin })}
              </span>
            </>
          ) : (
            <>
              <span className="status-path" title={tab.path || t('status.unsaved')}>
                {tab.path || t('status.unsaved')}
              </span>
              {/* Static dirty/saved indicator; the Save action is a floating
                  button (see App.jsx) so its position doesn't shift with the
                  path length. */}
              <span className={`status-dot ${dirty ? 'mod' : 'ok'}`}>
                {dirty ? '● ' + t('status.modified') : '✓ ' + t('status.saved')}
              </span>
            </>
          )
        ) : (
          <span className="status-path">{t('status.ready')}</span>
        )}
      </div>
      <div className="status-right">
        {isMobile ? (
          tab && (
            <>
              {window.api.capabilities?.canShare && (
                <button className="status-btn hm-share-btn" onClick={onShare} title={t('status.share')}>
                  <Icon name="share" size={17} />
                  <span>{t('status.shareShort')}</span>
                </button>
              )}
              <MobileMore
                dirty={dirty}
                onSave={onSave}
                onSettings={onSettings}
                sourceMode={sourceMode}
                onToggleSource={onToggleSource}
                theme={theme}
                setTheme={setTheme}
                lang={lang}
                setLang={setLang}
                customThemes={customThemes}
                customTheme={customTheme}
                onPickCustom={onPickCustom}
                onRefreshThemes={onRefreshThemes}
                fontSize={fontSize}
                onSetFontSize={onSetFontSize}
              />
            </>
          )
        ) : (
          <>
            <SyncStatusItem sync={sync} autoSync={autoSync} syncAuto={syncAuto} onOpen={onOpenSync} />
            {tab && <StatsControl stats={s} />}
            {onToggleReadingMode && (
              <button
                className={`status-btn hm-reading-btn${readingMode ? ' active' : ''}`}
                onClick={onToggleReadingMode}
                aria-pressed={readingMode}
                title={labelWithShortcut(t('tip.toggleReading'), 'view.readingMode', effectiveKeybindings)}
              >
                <Icon name={readingMode ? 'book' : 'pencil'} size={14} /> {readingMode ? t('status.reading') : t('status.editing')}
              </button>
            )}
            <button
              className="status-btn"
              onClick={onToggleSource}
              title={labelWithShortcut(t('tip.toggleSource'), 'view.toggleSource', effectiveKeybindings)}
            >
              <Icon name="code" size={14} /> {sourceMode ? t('status.source') : t('status.rich')}
            </button>
            <LayoutControl
              fontSize={fontSize}
              onSetFontSize={onSetFontSize}
              lineHeight={lineHeight}
              onSetLineHeight={onSetLineHeight}
              paragraphSpacing={paragraphSpacing}
              onSetParagraphSpacing={onSetParagraphSpacing}
              headingSpacing={headingSpacing}
              onSetHeadingSpacing={onSetHeadingSpacing}
              pageWidth={pageWidth}
              onSetPageWidth={onSetPageWidth}
            />
            <ThemePicker
              theme={theme}
              setTheme={setTheme}
              customThemes={customThemes}
              customTheme={customTheme}
              onPickCustom={onPickCustom}
              onRefreshThemes={onRefreshThemes}
              onOpenThemesFolder={onOpenThemesFolder}
              onGetMoreThemes={onGetMoreThemes}
            />
            <LangSwitch lang={lang} setLang={setLang} />
            <button
              className="status-btn"
              onClick={() => window.api.openExternal('https://github.com/BND-1/horseMD')}
              title="GitHub — github.com/BND-1/horseMD"
            >
              <Icon name="github" size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
