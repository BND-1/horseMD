import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'
import { THEMES, themeById } from '../themes.js'
import { LANGS } from '../i18n.jsx'
import { FONT_SIZE_MIN, FONT_SIZE_MAX } from '../settings.js'
import LayoutControl from './LayoutControl.jsx'

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
function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  return { open, setOpen, ref }
}


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
            onClick={() => {
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
  theme,
  setTheme,
  lang,
  setLang,
  sourceMode,
  onToggleSource,
  pageWidth,
  onSetPageWidth,
  fontSize,
  onSetFontSize,
  lineHeight,
  onSetLineHeight,
  paragraphSpacing,
  onSetParagraphSpacing,
  customThemes,
  customTheme,
  onPickCustom,
  onRefreshThemes,
  onOpenThemesFolder,
  onGetMoreThemes
}) {
  const { t } = useI18n()
  const s = useMemo(() => stats(tab?.content), [tab?.content])
  const dirty = tab && tab.content !== tab.savedContent
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
              {dirty ? (
                // Explicit Save button — appears only when there are unsaved
                // changes, the moment a user is most likely to want it. Avoids
                // a permanent button (Save is also Ctrl/Cmd+S).
                <button
                  className="status-btn hm-save-btn"
                  onClick={onSave}
                  title={t('tip.save')}
                >
                  <Icon name="save" size={13} /> {t('status.save')}
                </button>
              ) : (
                <span className={`status-dot ok`}>{'✓ ' + t('status.saved')}</span>
              )}
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
            {tab && <StatsControl stats={s} />}
            <button className="status-btn" onClick={onToggleSource} title={t('tip.toggleSource')}>
              <Icon name="code" size={14} /> {sourceMode ? t('status.source') : t('status.rich')}
            </button>
            <LayoutControl
              fontSize={fontSize}
              onSetFontSize={onSetFontSize}
              lineHeight={lineHeight}
              onSetLineHeight={onSetLineHeight}
              paragraphSpacing={paragraphSpacing}
              onSetParagraphSpacing={onSetParagraphSpacing}
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
