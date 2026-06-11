import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { BLOCK_TYPES, blockById, labelForBlockId } from '../blocks.js'
import { useI18n } from '../i18n.jsx'
import { THEMES, themeById } from '../themes.js'
import { LANGS } from '../i18n.jsx'
import { PAGE_WIDTHS } from '../page-width.js'

function stats(md) {
  const text = (md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[#>*_~\-\[\]()!]/g, ' ')
  const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length
  const chars = (md || '').length
  const readMin = Math.max(1, Math.round(words / 220))
  return { words, chars, readMin }
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

function BlockSwitcher({ activeBlock, onPickBlock }) {
  const { t } = useI18n()
  const { open, setOpen, ref } = usePopover()
  const known = blockById(activeBlock)
  const label = known ? t('block.' + activeBlock) : labelForBlockId(activeBlock)
  return (
    <div className="block-switch" ref={ref}>
      <button className="status-btn" onClick={() => setOpen((v) => !v)} title={t('tip.changeBlock')}>
        <Icon name="heading" size={14} /> {label}
        <span className="block-switch-caret">▾</span>
      </button>
      {open && (
        <div className="block-switch-menu">
          {BLOCK_TYPES.map((b) => (
            <button
              key={b.id}
              className={`block-menu-item${b.id === activeBlock ? ' active' : ''}`}
              onClick={() => {
                onPickBlock(b.id)
                setOpen(false)
              }}
            >
              <span className="block-menu-short">{b.short}</span>
              <span className="block-menu-name">{t('block.' + b.id)}</span>
              <span className="block-menu-sc">{b.shortcut}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ThemePicker({ theme, setTheme }) {
  const { lang, t } = useI18n()
  const { open, setOpen, ref } = usePopover()
  const cur = themeById(theme)
  return (
    <div className="block-switch" ref={ref}>
      <button className="status-btn" onClick={() => setOpen((v) => !v)} title={t('tip.toggleTheme')}>
        <span className="theme-swatch" style={{ background: cur.swatch }} />
        {lang === 'zh' ? cur.zh : cur.en}
        <span className="block-switch-caret">▾</span>
      </button>
      {open && (
        <div className="block-switch-menu theme-menu">
          {THEMES.map((th) => (
            <button
              key={th.id}
              className={`block-menu-item${th.id === theme ? ' active' : ''}`}
              onClick={() => {
                setTheme(th.id)
                setOpen(false)
              }}
            >
              <span className="theme-swatch" style={{ background: th.swatch }} />
              <span className="block-menu-name">{lang === 'zh' ? th.zh : th.en}</span>
            </button>
          ))}
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

function PageWidthPicker({ pageWidth, setPageWidth }) {
  const { t } = useI18n()
  const { open, setOpen, ref } = usePopover()
  return (
    <div className="block-switch" ref={ref}>
      <button className="status-btn" onClick={() => setOpen((v) => !v)} title={t('tip.pageWidth')}>
        <Icon name="columns" size={14} /> {t('pageWidth.' + pageWidth)}
        <span className="block-switch-caret">▾</span>
      </button>
      {open && (
        <div className="block-switch-menu">
          {PAGE_WIDTHS.map((item) => (
            <button
              key={item.id}
              className={`block-menu-item${item.id === pageWidth ? ' active' : ''}`}
              onClick={() => {
                setPageWidth(item.id)
                setOpen(false)
              }}
            >
              <span className="block-menu-name">{t('pageWidth.' + item.id)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function StatusBar({
  tab,
  theme,
  setTheme,
  lang,
  setLang,
  pageWidth,
  setPageWidth,
  sourceMode,
  onToggleSource,
  activeBlock,
  onPickBlock
}) {
  const { t } = useI18n()
  const s = useMemo(() => stats(tab?.content), [tab?.content])
  const dirty = tab && tab.content !== tab.savedContent
  return (
    <div className="statusbar">
      <div className="status-left">
        {tab ? (
          <>
            <span className="status-path" title={tab.path || t('status.unsaved')}>
              {tab.path || t('status.unsaved')}
            </span>
            <span className={`status-dot ${dirty ? 'mod' : 'ok'}`}>
              {dirty ? '● ' + t('status.modified') : '✓ ' + t('status.saved')}
            </span>
          </>
        ) : (
          <span className="status-path">{t('status.ready')}</span>
        )}
      </div>
      <div className="status-right">
        {tab && (
          <>
            <span>{t('status.words', { n: s.words })}</span>
            <span>{t('status.chars', { n: s.chars })}</span>
            <span>{t('status.read', { n: s.readMin })}</span>
          </>
        )}
        {tab && !sourceMode && <BlockSwitcher activeBlock={activeBlock} onPickBlock={onPickBlock} />}
        <button className="status-btn" onClick={onToggleSource} title={t('tip.toggleSource')}>
          <Icon name="code" size={14} /> {sourceMode ? t('status.source') : t('status.rich')}
        </button>
        <PageWidthPicker pageWidth={pageWidth} setPageWidth={setPageWidth} />
        <ThemePicker theme={theme} setTheme={setTheme} />
        <LangSwitch lang={lang} setLang={setLang} />
        <button
          className="status-btn"
          onClick={() => window.api.openExternal('https://github.com/BND-1/horseMD')}
          title="GitHub — github.com/BND-1/horseMD"
        >
          <Icon name="github" size={14} />
        </button>
      </div>
    </div>
  )
}
