import Toggle from '../ui/Toggle.jsx'
import AdjustGroup from '../ui/AdjustGroup.jsx'
import TypographyControls from './TypographyControls.jsx'
import UserCssSnippets from './UserCssSnippets.jsx'
import TableWrapPreview from './TableWrapPreview.jsx'
import {
  SOURCE_FONT_OFFSET_MIN,
  SOURCE_FONT_OFFSET_MAX,
  applySourceFontOffset
} from '../../settings.js'

const SOURCE_FONT_OFFSET_PRESETS = [
  { id: 'match', value: 0 },
  { id: 'larger', value: 2 },
  { id: 'xlarge', value: 4 },
  { id: 'xxlarge', value: 6 }
]

export default function DocumentAppearanceSettings({
  settings,
  onUpdateSettings,
  onHoverFont,
  activeCssSnippetId,
  onActiveCssSnippetIdChange,
  t
}) {
  const sourceOffset = Number.isFinite(settings.sourceFontOffset) ? settings.sourceFontOffset : 0
  const sourceOffsetIdx = SOURCE_FONT_OFFSET_PRESETS.findIndex((preset) => preset.value === sourceOffset)
  const sourcePx = Math.max(8, (settings.fontSize || 16) + sourceOffset)
  const offsetLabel = (sourceOffset > 0 ? '+' : '') + sourceOffset + ' px'

  return (
    <>
      <section className="settings-block" data-settings-group="typography">
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
      <section className="settings-block" data-settings-group="tables">
        <h2 className="settings-block-title">{t('settings.tables')}</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t('settings.tableAutoWrap')}</div>
            <div className="settings-row-desc">{t('settings.tableAutoWrapDesc')}</div>
          </div>
          <Toggle
            checked={settings.tableAutoWrap === true}
            onChange={(tableAutoWrap) => onUpdateSettings({ tableAutoWrap })}
            label={t('settings.tableAutoWrap')}
          />
        </div>
        <TableWrapPreview wraps={settings.tableAutoWrap === true} t={t} />
      </section>
      <section className="settings-block" data-settings-group="source-appearance">
        <h2 className="settings-block-title">{t('settings.sourceMode')}</h2>
        <p className="settings-block-desc">{t('settings.sourceFontDesc')}</p>
        <AdjustGroup
          title={t('settings.sourceFontOffset')}
          valueLabel={`${offsetLabel} · ${sourcePx}px`}
          presets={SOURCE_FONT_OFFSET_PRESETS.map((preset) => ({
            ...preset,
            label: t('settings.sourceFontOffset.' + preset.id)
          }))}
          activeIndex={sourceOffsetIdx}
          onPick={(preset) => onUpdateSettings({ sourceFontOffset: preset.value })}
          value={sourceOffset}
          min={SOURCE_FONT_OFFSET_MIN}
          max={SOURCE_FONT_OFFSET_MAX}
          round={Math.round}
          onSet={(value) => onUpdateSettings({ sourceFontOffset: value })}
          liveApply={applySourceFontOffset}
        />
      </section>
    </>
  )
}
