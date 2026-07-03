// Settings page — a full-tab view (kind:'settings') grouping every operable
// preference: typography (font size / line height / paragraph spacing / page
// width) with a live preview, spell-check toggle, theme, language, image-host
// command, and an About section. Opened from the ActivityBar gear button.
//
// StatusBar quick-controls (排版/主题/语言) stay where they are — this is their
// full-version home, not a replacement. Built incrementally across US-4/5/6.
import { useI18n, LANGS } from '../i18n.jsx'
import { THEMES } from '../themes.js'
import Toggle from './ui/Toggle.jsx'
import AdjustGroup from './ui/AdjustGroup.jsx'
import {
  PAGE_WIDTH_PRESETS,
  PAGE_WIDTH_MIN,
  PAGE_WIDTH_MAX,
  FONT_SIZE_PRESETS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  LINE_HEIGHT_PRESETS,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_MAX,
  PARA_SPACING_PRESETS,
  PARA_SPACING_MIN,
  PARA_SPACING_MAX,
  applyFontSize,
  applyLineHeight,
  applyParagraphSpacing,
  applyPageWidth
} from '../settings.js'

const round1 = (n) => Math.round(n * 10) / 10
const round10 = (n) => Math.round(n / 10) * 10
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''

export default function SettingsView({
  settings,
  onUpdateSettings,
  theme,
  setTheme,
  customThemes = [],
  customTheme,
  onPickCustom,
  onOpenThemesFolder,
  onGetMoreThemes,
  lang,
  setLang
}) {
  const { t } = useI18n()
  const { fontSize, lineHeight, paragraphSpacing, pageWidth } = settings

  const fontIdx = FONT_SIZE_PRESETS.findIndex((p) => p.size === fontSize)
  const lhIdx = LINE_HEIGHT_PRESETS.findIndex((p) => p.value === lineHeight)
  const psIdx = PARA_SPACING_PRESETS.findIndex((p) => p.value === paragraphSpacing)
  const isFull = pageWidth === 'full'
  const widthIdx = PAGE_WIDTH_PRESETS.findIndex((p) =>
    p.width === 'full' ? isFull : !isFull && pageWidth === p.width
  )

  return (
    <div className="settings-page">
      <div className="settings-card">
        <h1 className="settings-title">{t('settings.pageTitle')}</h1>
        <p className="settings-subtitle">{t('settings.pageSubtitle')}</p>

        {/* Typography — live preview + 4 sliders. */}
        <section className="settings-section">
          <div className="settings-section-head">
            <span className="settings-section-title">{t('settings.typography')}</span>
          </div>
          <div className="settings-preview markdown-body">
            <h2>{t('settings.previewHeading')}</h2>
            <p>{t('settings.previewBody')}</p>
            <ul>
              <li>{t('settings.previewListItem')}</li>
            </ul>
          </div>
          <AdjustGroup
            title={t('settings.fontSize')}
            valueLabel={fontSize + ' px'}
            presets={FONT_SIZE_PRESETS.map((p) => ({ ...p, label: t('settings.font.' + p.id) }))}
            activeIndex={fontIdx}
            onPick={(p) => onUpdateSettings({ fontSize: p.size })}
            value={fontSize}
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            round={Math.round}
            onSet={(s) => onUpdateSettings({ fontSize: s })}
            liveApply={applyFontSize}
          />
          <div className="hm-pop-sep" />
          <AdjustGroup
            title={t('settings.lineHeight')}
            valueLabel={round1(lineHeight).toFixed(1)}
            presets={LINE_HEIGHT_PRESETS.map((p) => ({ ...p, label: t('settings.lineHeightPreset.' + p.id) }))}
            activeIndex={lhIdx}
            onPick={(p) => onUpdateSettings({ lineHeight: p.value })}
            value={lineHeight}
            min={LINE_HEIGHT_MIN}
            max={LINE_HEIGHT_MAX}
            round={round1}
            onSet={(v) => onUpdateSettings({ lineHeight: v })}
            liveApply={applyLineHeight}
          />
          <div className="hm-pop-sep" />
          <AdjustGroup
            title={t('settings.paragraphSpacing')}
            valueLabel={round1(paragraphSpacing).toFixed(1) + ' em'}
            presets={PARA_SPACING_PRESETS.map((p) => ({ ...p, label: t('settings.paraSpacingPreset.' + p.id) }))}
            activeIndex={psIdx}
            onPick={(p) => onUpdateSettings({ paragraphSpacing: p.value })}
            value={paragraphSpacing}
            min={PARA_SPACING_MIN}
            max={PARA_SPACING_MAX}
            round={round1}
            onSet={(v) => onUpdateSettings({ paragraphSpacing: v })}
            liveApply={applyParagraphSpacing}
          />
          <div className="hm-pop-sep" />
          <AdjustGroup
            title={t('settings.pageWidth')}
            valueLabel={isFull ? t('settings.width.full') : pageWidth + ' px'}
            presets={PAGE_WIDTH_PRESETS.map((p) => ({ ...p, label: t('settings.width.' + p.id) }))}
            activeIndex={widthIdx}
            onPick={(p) => onUpdateSettings({ pageWidth: p.width })}
            value={isFull ? PAGE_WIDTH_MAX : pageWidth}
            min={PAGE_WIDTH_MIN}
            max={PAGE_WIDTH_MAX}
            round={round10}
            onSet={(w) => onUpdateSettings({ pageWidth: w })}
            liveApply={applyPageWidth}
          />
        </section>

        {/* Proofreading — spell-check toggle. */}
        <section className="settings-section">
          <div className="settings-section-head">
            <span className="settings-section-title">{t('settings.proofreading')}</span>
          </div>
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
        </section>

        {/* Appearance — built-in theme swatches + custom themes. */}
        <section className="settings-section">
          <div className="settings-section-head">
            <span className="settings-section-title">{t('settings.appearance')}</span>
          </div>
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
            <button className="settings-link-btn" onClick={() => onOpenThemesFolder && onOpenThemesFolder()}>
              {t('settings.openThemesFolder')}
            </button>
            <button className="settings-link-btn" onClick={() => onGetMoreThemes && onGetMoreThemes()}>
              {t('settings.getMoreThemes')}
            </button>
          </div>
        </section>

        {/* Language. */}
        <section className="settings-section">
          <div className="settings-section-head">
            <span className="settings-section-title">{t('settings.language')}</span>
          </div>
          <div className="settings-langs">
            {LANGS.map((l) => (
              <button
                key={l.id}
                className={`settings-lang${l.id === lang ? ' active' : ''}`}
                onClick={() => setLang(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </section>

        {/* Image host — Typora-style custom upload command. */}
        <section className="settings-section">
          <div className="settings-section-head">
            <span className="settings-section-title">{t('settings.imageHost')}</span>
          </div>
          <div className="settings-row-text" style={{ marginBottom: 10 }}>
            <div className="settings-row-desc">{t('settings.imageHostDesc')}</div>
          </div>
          <input
            className="settings-input"
            type="text"
            spellCheck={false}
            placeholder={t('settings.imageHostPlaceholder')}
            value={settings.imageUploadCommand || ''}
            onChange={(e) => onUpdateSettings({ imageUploadCommand: e.target.value })}
          />
        </section>

        {/* About. */}
        <section className="settings-section">
          <div className="settings-section-head">
            <span className="settings-section-title">{t('settings.about')}</span>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">HorseMD {APP_VERSION && <span className="settings-version">{APP_VERSION}</span>}</div>
          </div>
          <div className="settings-row settings-row-actions">
            <button className="settings-link-btn" onClick={() => window.api.openExternal('https://github.com/BND-1/horseMD')}>
              GitHub
            </button>
            <button className="settings-link-btn" onClick={() => window.api.openExternal('https://gitee.com/yty11167/horse-md')}>
              Gitee
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
