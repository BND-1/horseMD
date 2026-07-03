// A segmented-preset + fine-tune slider group, generic over a numeric value.
// Extracted from LayoutControl so the Settings page can reuse the exact same
// control (and the live-apply-during-drag behavior). CSS lives in app.css
// (.hm-adjust-group / .hm-seg / .hm-ftrack) — shared by both consumers.
import { useRef, useState } from 'react'
import { useI18n } from '../../i18n.jsx'

// Pointer X over `track` → value in [min, max], clamped + rounded.
export const valueFromX = (track, clientX, min, max, round) => {
  const r = track.getBoundingClientRect()
  const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  return round(min + p * (max - min))
}

// `liveApply`, if given, writes the CSS variable DIRECTLY during a drag (no
// React state round-trip), so the slider stays smooth even though each new value
// reflows the whole editor. The value is persisted via `onSet` once, on release.
export default function AdjustGroup({ title, valueLabel, presets, activeIndex, onPick, value, min, max, round = (n) => n, onSet, liveApply }) {
  const { t } = useI18n()
  const trackRef = useRef(null)
  const draftRef = useRef(null) // latest drag value (ref, so pointerup reads it)
  const [dragging, setDragging] = useState(false)
  const [draft, setDraft] = useState(null) // live drag value (null = use prop)
  const cur = draft === null ? value : draft
  const pct = (cur - min) / (max - min)
  const startDrag = (e) => {
    e.preventDefault()
    setDragging(true)
    const apply = (v) => {
      draftRef.current = v
      setDraft(v)
      if (liveApply) liveApply(v)
    }
    apply(valueFromX(trackRef.current, e.clientX, min, max, round))
    const onMove = (ev) => apply(valueFromX(trackRef.current, ev.clientX, min, max, round))
    const onUp = () => {
      setDragging(false)
      onSet(draftRef.current) // commit the final dragged value
      setDraft(null)
      draftRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return (
    <div className="hm-adjust-group">
      <div className="hm-pop-head">
        <span className="hm-pop-title">{title}</span>
        <span className="hm-pop-value">{valueLabel}</span>
      </div>
      <div className="hm-seg" style={{ '--seg-count': presets.length, '--seg-index': activeIndex }}>
        {activeIndex >= 0 && <span className="hm-seg-pill" aria-hidden="true" />}
        {presets.map((p, i) => (
          <button
            key={p.id}
            className={`hm-seg-item${i === activeIndex ? ' active' : ''}`}
            onClick={() => onPick(p)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className={`hm-fine${dragging ? ' dragging' : ''}`}>
        <span className="hm-fine-label">{t('settings.fineTune')}</span>
        <div className="hm-ftrack" ref={trackRef} onPointerDown={startDrag}>
          <div className="hm-ffill" style={{ width: pct * 100 + '%' }} />
          <div className="hm-fthumb" style={{ left: pct * 100 + '%' }} />
        </div>
      </div>
    </div>
  )
}
