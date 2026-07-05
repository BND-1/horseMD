// Settings page — a full-tab view (kind:'settings'). ONE scrolling page with all
// sections stacked. Typography section is two-column: compact sliders left, a live
// HorseMD-intro preview right (reflects font size / line height / paragraph
// spacing / page width as you drag). Sections: Typography · Proofreading (spell-
// check) · Appearance (themes) · Language · Image host · About. Opened from the
// ActivityBar gear / mobile "•••" sheet.
//
// StatusBar quick-controls (排版/主题/语言) stay where they are — this is their
// full-version home, not a replacement.
import { useState } from 'react'
import { useI18n, LANGS } from '../i18n.jsx'
import { THEMES } from '../themes.js'
import { isNewerVersion } from '../paths.js'
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
  return (
    <div className="settings-page">
      <div className="settings-sections">
        {/* Typography — sliders left, live preview right. */}
        <section className="settings-block">
          <h2 className="settings-block-title">{t('settings.typography')}</h2>
          <TypographyControls settings={settings} onUpdateSettings={onUpdateSettings} t={t} />
        </section>

        {/* Appearance. */}
        <section className="settings-block">
          <h2 className="settings-block-title">{t('settings.appearance')}</h2>
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
          <div className="settings-row" style={{ marginTop: 14 }}>
            <div className="settings-row-text">
              <div className="settings-row-label">{t('settings.showHiddenFiles')}</div>
              <div className="settings-row-desc">{t('settings.showHiddenFilesDesc')}</div>
            </div>
            <Toggle
              checked={!!settings.showHiddenFiles}
              onChange={(v) => onUpdateSettings({ showHiddenFiles: v })}
              label={t('settings.showHiddenFiles')}
            />
          </div>
        </section>

        {/* Proofreading. */}
        <section className="settings-block">
          <h2 className="settings-block-title">{t('settings.proofreading')}</h2>
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

        {/* Language. */}
        <section className="settings-block">
          <h2 className="settings-block-title">{t('settings.language')}</h2>
          <div className="settings-langs">
            {LANGS.map((l) => (
              <button key={l.id} className={`settings-lang${l.id === lang ? ' active' : ''}`} onClick={() => setLang(l.id)}>
                {l.label}
              </button>
            ))}
          </div>
        </section>

        {/* Image host. */}
        <section className="settings-block">
          <h2 className="settings-block-title">{t('settings.imageHost')}</h2>
          <p className="settings-block-desc">{t('settings.imageHostDesc')}</p>
          <input
            className="settings-input" type="text" spellCheck={false}
            placeholder={t('settings.imageHostPlaceholder')}
            value={settings.imageUploadCommand || ''}
            onChange={(e) => onUpdateSettings({ imageUploadCommand: e.target.value })}
          />
        </section>

        {/* About. */}
        <section className="settings-block">
          <h2 className="settings-block-title">{t('settings.about')}</h2>
          <div className="settings-row">
            <div className="settings-row-label">HorseMD {APP_VERSION && <span className="settings-version">{APP_VERSION}</span>}</div>
          </div>
          <UpdateChecker t={t} />
          <div className="settings-row settings-row-actions">
            <button className="settings-link-btn" onClick={() => window.api.openExternal('https://horsemd.yangsir.net')}>{t('settings.website')}</button>
            <button className="settings-link-btn" onClick={() => window.api.openExternal('https://github.com/BND-1/horseMD')}>GitHub</button>
            <button className="settings-link-btn" onClick={() => window.api.openExternal('https://gitee.com/yty11167/horse-md')}>Gitee</button>
          </div>
        </section>
      </div>
    </div>
  )
}

// Typography: compact sliders (left) + live HorseMD-intro preview (right).
function TypographyControls({ settings, onUpdateSettings, t }) {
  const { fontSize, lineHeight, paragraphSpacing, pageWidth } = settings
  const fontIdx = FONT_SIZE_PRESETS.findIndex((p) => p.size === fontSize)
  const lhIdx = LINE_HEIGHT_PRESETS.findIndex((p) => p.value === lineHeight)
  const psIdx = PARA_SPACING_PRESETS.findIndex((p) => p.value === paragraphSpacing)
  const isFull = pageWidth === 'full'
  const widthIdx = PAGE_WIDTH_PRESETS.findIndex((p) =>
    p.width === 'full' ? isFull : !isFull && pageWidth === p.width
  )
  return (
    <div className="settings-typo">
      <div className="settings-typo-controls">
        <AdjustGroup
          title={t('settings.fontSize')} valueLabel={fontSize + ' px'}
          presets={FONT_SIZE_PRESETS.map((p) => ({ ...p, label: t('settings.font.' + p.id) }))}
          activeIndex={fontIdx} onPick={(p) => onUpdateSettings({ fontSize: p.size })}
          value={fontSize} min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} round={Math.round}
          onSet={(s) => onUpdateSettings({ fontSize: s })} liveApply={applyFontSize}
        />
        <AdjustGroup
          title={t('settings.lineHeight')} valueLabel={round1(lineHeight).toFixed(1)}
          presets={LINE_HEIGHT_PRESETS.map((p) => ({ ...p, label: t('settings.lineHeightPreset.' + p.id) }))}
          activeIndex={lhIdx} onPick={(p) => onUpdateSettings({ lineHeight: p.value })}
          value={lineHeight} min={LINE_HEIGHT_MIN} max={LINE_HEIGHT_MAX} round={round1}
          onSet={(v) => onUpdateSettings({ lineHeight: v })} liveApply={applyLineHeight}
        />
        <AdjustGroup
          title={t('settings.paragraphSpacing')} valueLabel={round1(paragraphSpacing).toFixed(1) + ' em'}
          presets={PARA_SPACING_PRESETS.map((p) => ({ ...p, label: t('settings.paraSpacingPreset.' + p.id) }))}
          activeIndex={psIdx} onPick={(p) => onUpdateSettings({ paragraphSpacing: p.value })}
          value={paragraphSpacing} min={PARA_SPACING_MIN} max={PARA_SPACING_MAX} round={round1}
          onSet={(v) => onUpdateSettings({ paragraphSpacing: v })} liveApply={applyParagraphSpacing}
        />
        <AdjustGroup
          title={t('settings.pageWidth')} valueLabel={isFull ? t('settings.width.full') : pageWidth + ' px'}
          presets={PAGE_WIDTH_PRESETS.map((p) => ({ ...p, label: t('settings.width.' + p.id) }))}
          activeIndex={widthIdx} onPick={(p) => onUpdateSettings({ pageWidth: p.width })}
          value={isFull ? PAGE_WIDTH_MAX : pageWidth} min={PAGE_WIDTH_MIN} max={PAGE_WIDTH_MAX} round={round10}
          onSet={(w) => onUpdateSettings({ pageWidth: w })} liveApply={applyPageWidth}
        />
      </div>
      <div className="settings-typo-preview">
        <div className="settings-preview markdown-body">
          <h2>HorseMD</h2>
          <p>{t('settings.previewIntro')}</p>
          <pre><code>{t('settings.previewCode')}</code></pre>
          <ul>
            <li>{t('settings.previewFeature1')}</li>
            <li>{t('settings.previewFeature2')}</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

// Manual "check for updates" — calls the same update:check IPC the startup
// notify-only check uses. Shows checking → up-to-date / new-version-available
// (with a 前往下载 link). Self-contained: keeps SettingsView lean.
function UpdateChecker({ t }) {
  // status: 'idle' | 'checking' | 'uptodate' | 'available' | 'error'
  const [status, setStatus] = useState('idle')
  const [info, setInfo] = useState(null) // { latest, url }

  const run = async () => {
    setStatus('checking')
    try {
      const r = await window.api.checkUpdate()
      if (!r?.ok || !r.latest) { setStatus('error'); return }
      if (isNewerVersion(r.latest, r.current)) {
        setInfo({ latest: r.latest, url: r.url })
        setStatus('available')
      } else {
        setStatus('uptodate')
      }
    } catch {
      setStatus('error')
    }
  }

  return (
    <div className="settings-row settings-update-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{t('settings.updateTitle')}</div>
        <div className="settings-row-desc settings-update-status">
          {status === 'checking' && t('settings.checking')}
          {status === 'uptodate' && t('settings.upToDate')}
          {status === 'available' && info && (
            <span>
              {t('settings.newVersionAvailable', { v: info.latest })}
              {' · '}
              <button className="settings-inline-link" onClick={() => info.url && window.api.openExternal(info.url)}>
                {t('update.download')} →
              </button>
            </span>
          )}
          {status === 'error' && t('settings.checkFailed')}
        </div>
      </div>
      <button
        className="settings-link-btn"
        onClick={run}
        disabled={status === 'checking'}
      >
        {status === 'checking' ? t('settings.checking') : t('settings.checkUpdate')}
      </button>
    </div>
  )
}
