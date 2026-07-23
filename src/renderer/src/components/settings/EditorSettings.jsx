import Toggle from '../ui/Toggle.jsx'
import TypographyControls from './TypographyControls.jsx'
import AdjustGroup from '../ui/AdjustGroup.jsx'
import UserCssSnippets from './UserCssSnippets.jsx'
import {
  SOURCE_FONT_OFFSET_MIN,
  SOURCE_FONT_OFFSET_MAX,
  applySourceFontOffset
} from '../../settings.js'

// Source-font offset quick presets (px relative to the body font). Default is
// 'match' (0 = same as document body); the rest let low-vision readers enlarge.
const SOURCE_FONT_OFFSET_PRESETS = [
  { id: 'match', value: 0 },
  { id: 'larger', value: 2 },
  { id: 'xlarge', value: 4 },
  { id: 'xxlarge', value: 6 }
]

export default function EditorSettings({
  settings, onUpdateSettings, onHoverFont,
  activeCssSnippetId, onActiveCssSnippetIdChange,
  t
}) {
  const sourceOffset = Number.isFinite(settings.sourceFontOffset) ? settings.sourceFontOffset : 0
  const sourceOffsetIdx = SOURCE_FONT_OFFSET_PRESETS.findIndex((p) => p.value === sourceOffset)
  // Resulting source font size = body font size + offset (clamped ≥ 8px for sanity).
  const sourcePx = Math.max(8, (settings.fontSize || 16) + sourceOffset)
  const offsetLabel = (sourceOffset > 0 ? '+' : '') + sourceOffset + ' px'
  return (
    <>
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.typography')}</h2>
        <TypographyControls
          settings={settings}
          onUpdateSettings={onUpdateSettings}
          onHoverFont={onHoverFont}
          t={t}
        />
      </section>
      <UserCssSnippets
        settings={settings}
        onUpdateSettings={onUpdateSettings}
        activeSnippetId={activeCssSnippetId}
        onActiveSnippetIdChange={onActiveCssSnippetIdChange}
        t={t}
      />
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.sourceMode')}</h2>
        <p className="settings-block-desc">{t('settings.sourceFontDesc')}</p>
        <AdjustGroup
          title={t('settings.sourceFontOffset')}
          valueLabel={`${offsetLabel} · ${sourcePx}px`}
          presets={SOURCE_FONT_OFFSET_PRESETS.map((p) => ({ ...p, label: t('settings.sourceFontOffset.' + p.id) }))}
          activeIndex={sourceOffsetIdx}
          onPick={(p) => onUpdateSettings({ sourceFontOffset: p.value })}
          value={sourceOffset}
          min={SOURCE_FONT_OFFSET_MIN}
          max={SOURCE_FONT_OFFSET_MAX}
          round={Math.round}
          onSet={(v) => onUpdateSettings({ sourceFontOffset: v })}
          liveApply={applySourceFontOffset}
        />
      </section>
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
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t('settings.inlineMathDelete')}</div>
            <div className="settings-row-desc">{t('settings.inlineMathDeleteDesc')}</div>
          </div>
          <div className="settings-segmented">
            {['protect', 'fast'].map((mode) => (
              <button
                key={mode}
                type="button"
                className={`settings-segmented-option${(settings.inlineMathDeleteMode || 'protect') === mode ? ' active' : ''}`}
                onClick={() => onUpdateSettings({ inlineMathDeleteMode: mode })}
              >
                {t(`settings.inlineMathDelete.${mode}`)}
              </button>
            ))}
          </div>
        </div>
      </section>
    </>
  )
}
