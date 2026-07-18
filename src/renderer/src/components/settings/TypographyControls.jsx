import { useCallback, useRef, useState } from 'react'
import AdjustGroup from '../ui/AdjustGroup.jsx'
import FontPicker from './FontPicker.jsx'
import {
  PAGE_WIDTH_PRESETS, PAGE_WIDTH_MIN, PAGE_WIDTH_MAX,
  FONT_SIZE_PRESETS, FONT_SIZE_MIN, FONT_SIZE_MAX,
  LINE_HEIGHT_PRESETS, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX,
  PARA_SPACING_PRESETS, PARA_SPACING_MIN, PARA_SPACING_MAX,
  applyFontSize, applyLineHeight, applyParagraphSpacing, applyPageWidth
} from '../../settings.js'

const round1 = (n) => Math.round(n * 10) / 10
const round10 = (n) => Math.round(n / 10) * 10

export default function TypographyControls({ settings, onUpdateSettings, onHoverFont, t }) {
  const { fontSize, lineHeight, paragraphSpacing, pageWidth } = settings
  const fontIdx = FONT_SIZE_PRESETS.findIndex((p) => p.size === fontSize)
  const lhIdx = LINE_HEIGHT_PRESETS.findIndex((p) => p.value === lineHeight)
  const psIdx = PARA_SPACING_PRESETS.findIndex((p) => p.value === paragraphSpacing)
  const isFull = pageWidth === 'full'
  const widthIdx = PAGE_WIDTH_PRESETS.findIndex((p) =>
    p.width === 'full' ? isFull : !isFull && pageWidth === p.width
  )
  const fontsLoadedRef = useRef(false)
  const [fontFamilies, setFontFamilies] = useState(null)
  const ensureFonts = useCallback(async () => {
    if (fontsLoadedRef.current || typeof window.queryLocalFonts !== 'function') return
    fontsLoadedRef.current = true
    try {
      if (window.api.allowLocalFonts && !await window.api.allowLocalFonts()) {
        throw new Error('Local font access was not authorized')
      }
      const all = await window.queryLocalFonts()
      setFontFamilies([...new Set(all.map((f) => f.family))].sort((a, b) => a.localeCompare(b)))
    } catch {
      fontsLoadedRef.current = false
    }
  }, [])

  return (
    <div className="settings-typo">
      <div className="settings-typo-controls">
        <div className="settings-font-pickers">
          <FontPicker
            label={t('settings.fontWrite')}
            value={settings.fontWrite || ''}
            placeholder={t('settings.fontWritePlaceholder')}
            fonts={fontFamilies}
            onLoadFonts={ensureFonts}
            onChange={(fontWrite) => onUpdateSettings({ fontWrite })}
            onHover={(f) => onHoverFont((h) => ({ ...h, write: f }))}
            footer={
              <button type="button" className="settings-font-footer-link" onClick={() => window.api.openExternal('https://www.foundertype.com/')}>
                {t('settings.browseMoreFonts')} →
              </button>
            }
            t={t}
          />
          <FontPicker
            label={t('settings.fontMono')}
            value={settings.fontMono || ''}
            placeholder={t('settings.fontMonoPlaceholder')}
            fonts={fontFamilies}
            onLoadFonts={ensureFonts}
            onChange={(fontMono) => onUpdateSettings({ fontMono })}
            onHover={(f) => onHoverFont((h) => ({ ...h, mono: f }))}
            footer={
              <button type="button" className="settings-font-footer-link" onClick={() => window.api.openExternal('https://www.nerdfonts.com/font-downloads')}>
                {t('settings.browseMoreCodeFonts')} →
              </button>
            }
            t={t}
          />
          <p className="settings-font-hint">{t('settings.fontHint')}</p>
        </div>
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
