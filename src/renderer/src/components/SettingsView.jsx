// Settings page — a full-tab view (kind:'settings'). LEFT-RIGHT layout: a
// section nav on the left, the active section's content on the right. Sections:
// Typography (font/line-height/para-spacing/page-width + live preview) ·
// Proofreading (spell-check) · Appearance (themes) · Language · Image host · About.
// Opened from the ActivityBar gear (desktop) / mobile "•••" sheet.
//
// StatusBar quick-controls (排版/主题/语言) stay where they are — this is their
// full-version home, not a replacement. Built across US-4/5/6; layout refined to
// two-pane (left nav + right content) since there are only a few sections.
import { useState } from 'react'
import { useI18n, LANGS } from '../i18n.jsx'
import { THEMES } from '../themes.js'
import { Icon } from './icons.jsx'
import Toggle from './ui/Toggle.jsx'
import AdjustGroup from './ui/AdjustGroup.jsx'
import {
  PAGE_WIDTH_PRESETS, PAGE_WIDTH_MIN, PAGE_WIDTH_MAX,
  FONT_SIZE_PRESETS, FONT_SIZE_MIN, FONT_SIZE_MAX,
  LINE_HEIGHT_PRESETS, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX,
  PARA_SPACING_PRESETS, PARA_SPACING_MIN, PARA_SPACING_MAX,
  applyFontSize, applyLineHeight, applyParagraphSpacing, applyPageWidth
} from '../settings.js'

const round1 = (n) => Math.round(n * 10) / 10
const round10 = (n) => Math.round(n / 10) * 10
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''

export default function SettingsView({
  settings, onUpdateSettings,
  theme, setTheme, customThemes = [], customTheme, onPickCustom,
  onOpenThemesFolder, onGetMoreThemes,
  lang, setLang
}) {
  const { t } = useI18n()
  const [section, setSection] = useState('typography')
  const { fontSize, lineHeight, paragraphSpacing, pageWidth } = settings

  const nav = [
    { id: 'typography', icon: 'text-size', label: t('settings.typography') },
    { id: 'proofreading', icon: 'check', label: t('settings.proofreading') },
    { id: 'appearance', icon: 'sun', label: t('settings.appearance') },
    { id: 'language', icon: 'globe', label: t('settings.language') },
    { id: 'imageHost', icon: 'image', label: t('settings.imageHost') },
    { id: 'about', icon: 'github', label: t('settings.about') }
  ]

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        {nav.map((n) => (
          <button
            key={n.id}
            className={`settings-nav-item${section === n.id ? ' active' : ''}`}
            onClick={() => setSection(n.id)}
          >
            <Icon name={n.icon} size={16} />
            <span>{n.label}</span>
          </button>
        ))}
      </aside>

      <main className="settings-content">
        {section === 'typography' && (
          <TypographySection settings={settings} onUpdateSettings={onUpdateSettings} t={t} />
        )}
        {section === 'proofreading' && (
          <ProofreadingSection settings={settings} onUpdateSettings={onUpdateSettings} t={t} />
        )}
        {section === 'appearance' && (
          <AppearanceSection
            theme={theme} setTheme={setTheme} customThemes={customThemes} customTheme={customTheme}
            onPickCustom={onPickCustom} onOpenThemesFolder={onOpenThemesFolder} onGetMoreThemes={onGetMoreThemes}
            lang={lang} t={t}
          />
        )}
        {section === 'language' && <LanguageSection lang={lang} setLang={setLang} t={t} />}
        {section === 'imageHost' && <ImageHostSection settings={settings} onUpdateSettings={onUpdateSettings} t={t} />}
        {section === 'about' && <AboutSection t={t} />}
      </main>
    </div>
  )
}

/* Each section is a self-contained block rendered in the right content pane. */

function SectionShell({ title, desc, children }) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <span className="settings-section-title">{title}</span>
      </div>
      {desc && <p className="settings-section-desc">{desc}</p>}
      {children}
    </section>
  )
}

function TypographySection({ settings, onUpdateSettings, t }) {
  const { fontSize, lineHeight, paragraphSpacing, pageWidth } = settings
  const fontIdx = FONT_SIZE_PRESETS.findIndex((p) => p.size === fontSize)
  const lhIdx = LINE_HEIGHT_PRESETS.findIndex((p) => p.value === lineHeight)
  const psIdx = PARA_SPACING_PRESETS.findIndex((p) => p.value === paragraphSpacing)
  const isFull = pageWidth === 'full'
  const widthIdx = PAGE_WIDTH_PRESETS.findIndex((p) =>
    p.width === 'full' ? isFull : !isFull && pageWidth === p.width
  )
  return (
    <>
      <h1 className="settings-title">{t('settings.typography')}</h1>
      <p className="settings-subtitle">{t('settings.previewBody')}</p>
      <div className="settings-preview markdown-body">
        <h2>{t('settings.previewHeading')}</h2>
        <p>{t('settings.previewBody')}</p>
        <ul><li>{t('settings.previewListItem')}</li></ul>
      </div>
      <SectionShell title={t('settings.fontSize')}>
        <AdjustGroup
          title={t('settings.fontSize')} valueLabel={fontSize + ' px'}
          presets={FONT_SIZE_PRESETS.map((p) => ({ ...p, label: t('settings.font.' + p.id) }))}
          activeIndex={fontIdx} onPick={(p) => onUpdateSettings({ fontSize: p.size })}
          value={fontSize} min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} round={Math.round}
          onSet={(s) => onUpdateSettings({ fontSize: s })} liveApply={applyFontSize}
        />
      </SectionShell>
      <SectionShell title={t('settings.lineHeight')}>
        <AdjustGroup
          title={t('settings.lineHeight')} valueLabel={round1(lineHeight).toFixed(1)}
          presets={LINE_HEIGHT_PRESETS.map((p) => ({ ...p, label: t('settings.lineHeightPreset.' + p.id) }))}
          activeIndex={lhIdx} onPick={(p) => onUpdateSettings({ lineHeight: p.value })}
          value={lineHeight} min={LINE_HEIGHT_MIN} max={LINE_HEIGHT_MAX} round={round1}
          onSet={(v) => onUpdateSettings({ lineHeight: v })} liveApply={applyLineHeight}
        />
      </SectionShell>
      <SectionShell title={t('settings.paragraphSpacing')}>
        <AdjustGroup
          title={t('settings.paragraphSpacing')} valueLabel={round1(paragraphSpacing).toFixed(1) + ' em'}
          presets={PARA_SPACING_PRESETS.map((p) => ({ ...p, label: t('settings.paraSpacingPreset.' + p.id) }))}
          activeIndex={psIdx} onPick={(p) => onUpdateSettings({ paragraphSpacing: p.value })}
          value={paragraphSpacing} min={PARA_SPACING_MIN} max={PARA_SPACING_MAX} round={round1}
          onSet={(v) => onUpdateSettings({ paragraphSpacing: v })} liveApply={applyParagraphSpacing}
        />
      </SectionShell>
      <SectionShell title={t('settings.pageWidth')}>
        <AdjustGroup
          title={t('settings.pageWidth')} valueLabel={isFull ? t('settings.width.full') : pageWidth + ' px'}
          presets={PAGE_WIDTH_PRESETS.map((p) => ({ ...p, label: t('settings.width.' + p.id) }))}
          activeIndex={widthIdx} onPick={(p) => onUpdateSettings({ pageWidth: p.width })}
          value={isFull ? PAGE_WIDTH_MAX : pageWidth} min={PAGE_WIDTH_MIN} max={PAGE_WIDTH_MAX} round={round10}
          onSet={(w) => onUpdateSettings({ pageWidth: w })} liveApply={applyPageWidth}
        />
      </SectionShell>
    </>
  )
}

function ProofreadingSection({ settings, onUpdateSettings, t }) {
  return (
    <>
      <h1 className="settings-title">{t('settings.proofreading')}</h1>
      <p className="settings-subtitle">{t('settings.spellcheckDesc')}</p>
      <SectionShell title={t('settings.spellcheck')}>
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t('settings.spellcheck')}</div>
            <div className="settings-row-desc">{t('settings.spellcheckDesc')}</div>
          </div>
          <Toggle
            checked={!!settings.spellcheck}
            onChange={(v) => onUpdateSettings({ spellcheck: v })}
            label={t('settings.spellcheck')}
          />
        </div>
      </SectionShell>
    </>
  )
}

function AppearanceSection({ theme, setTheme, customThemes, customTheme, onPickCustom, onOpenThemesFolder, onGetMoreThemes, lang, t }) {
  return (
    <>
      <h1 className="settings-title">{t('settings.appearance')}</h1>
      <p className="settings-subtitle">{t('settings.pageSubtitle')}</p>
      <SectionShell title={t('settings.appearance')}>
        <div className="settings-swatches">
          {THEMES.map((th) => (
            <button
              key={th.id}
              className={`settings-swatch${!customTheme && th.id === theme ? ' active' : ''}`}
              style={{ background: th.swatch }}
              title={lang === 'zh' ? th.zh : th.en}
              onClick={() => setTheme(th.id)}
            >
              <span className="settings-swatch-name">{lang === 'zh' ? th.zh : th.en}</span>
            </button>
          ))}
          {customThemes.map((c) => (
            <button
              key={c.file}
              className={`settings-swatch settings-swatch-custom${customTheme === c.file ? ' active' : ''}`}
              style={{ background: c.swatch || 'var(--accent-soft)' }}
              title={c.name}
              onClick={() => onPickCustom && onPickCustom(c.file)}
            >
              <span className="settings-swatch-name">{c.name}</span>
            </button>
          ))}
        </div>
        <div className="settings-row settings-row-actions">
          <button className="settings-link-btn" onClick={() => onOpenThemesFolder && onOpenThemesFolder()}>{t('settings.openThemesFolder')}</button>
          <button className="settings-link-btn" onClick={() => onGetMoreThemes && onGetMoreThemes()}>{t('settings.getMoreThemes')}</button>
        </div>
      </SectionShell>
    </>
  )
}

function LanguageSection({ lang, setLang, t }) {
  return (
    <>
      <h1 className="settings-title">{t('settings.language')}</h1>
      <p className="settings-subtitle">{t('settings.pageSubtitle')}</p>
      <SectionShell title={t('settings.language')}>
        <div className="settings-langs">
          {LANGS.map((l) => (
            <button key={l.id} className={`settings-lang${l.id === lang ? ' active' : ''}`} onClick={() => setLang(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
      </SectionShell>
    </>
  )
}

function ImageHostSection({ settings, onUpdateSettings, t }) {
  return (
    <>
      <h1 className="settings-title">{t('settings.imageHost')}</h1>
      <p className="settings-subtitle">{t('settings.imageHostDesc')}</p>
      <SectionShell title={t('settings.imageHost')}>
        <input
          className="settings-input" type="text" spellCheck={false}
          placeholder={t('settings.imageHostPlaceholder')}
          value={settings.imageUploadCommand || ''}
          onChange={(e) => onUpdateSettings({ imageUploadCommand: e.target.value })}
        />
      </SectionShell>
    </>
  )
}

function AboutSection({ t }) {
  return (
    <>
      <h1 className="settings-title">{t('settings.about')}</h1>
      <p className="settings-subtitle">{t('settings.pageSubtitle')}</p>
      <SectionShell title={t('settings.about')}>
        <div className="settings-row">
          <div className="settings-row-label">HorseMD {APP_VERSION && <span className="settings-version">{APP_VERSION}</span>}</div>
        </div>
        <div className="settings-row settings-row-actions">
          <button className="settings-link-btn" onClick={() => window.api.openExternal('https://github.com/BND-1/horseMD')}>GitHub</button>
          <button className="settings-link-btn" onClick={() => window.api.openExternal('https://gitee.com/yty11167/horse-md')}>Gitee</button>
        </div>
      </SectionShell>
    </>
  )
}
