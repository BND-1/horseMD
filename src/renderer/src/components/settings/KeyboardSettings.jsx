import { useEffect, useMemo, useState } from 'react'
import { COMMAND_CATEGORIES, COMMAND_DEFINITIONS, getCommandTitle, isCommandAvailable } from '../../lib/commands/command-definitions.js'
import { getConflictsForCommand } from '../../lib/commands/keybinding-conflicts.js'
import { eventToKeybinding, keybindingToDisplay } from '../../lib/commands/keybinding-normalize.js'
import { getReservedKeybindingReason } from '../../lib/commands/keybinding-reserved.js'

const CATEGORY_ORDER = [
  COMMAND_CATEGORIES.FILE,
  COMMAND_CATEGORIES.VIEW,
  COMMAND_CATEGORIES.EDITOR,
  COMMAND_CATEGORIES.REVIEW
]

function commandCategoryLabel(category, t) {
  return t(`settings.keyboard.category.${category}`)
}

function shortcutIssueMessage(issue, platform, t) {
  if (!issue) return ''
  if (issue.type === 'conflict') {
    return t('settings.keyboardConflict', {
      keys: keybindingToDisplay(issue.binding, platform),
      command: getCommandTitle(issue.conflicts[0].command || { id: issue.conflicts[0].commandId }, t)
    })
  }
  if (issue.type === 'reserved') {
    return t('settings.keyboardReserved', {
      keys: keybindingToDisplay(issue.binding, platform),
      reason: t(`settings.keyboardReserved.${issue.reason}`)
    })
  }
  return ''
}

export default function KeyboardSettings({
  effectiveKeybindings,
  keybindingState,
  onSetKeybindings,
  onResetCommand,
  onResetAll,
  t
}) {
  const platform = window.api?.platform || (navigator.platform?.toLowerCase().includes('mac') ? 'darwin' : 'win32')
  const caps = window.api?.capabilities || {}
  const commands = useMemo(
    () => COMMAND_DEFINITIONS.filter((command) => isCommandAvailable(command, caps)),
    [caps]
  )
  const [recordingId, setRecordingId] = useState(null)
  const [conflict, setConflict] = useState(null)
  const [reserved, setReserved] = useState(null)
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()

  useEffect(() => {
    if (!recordingId) return
    const onKey = (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecordingId(null)
        setConflict(null)
        setReserved(null)
        return
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        onSetKeybindings(recordingId, [])
        setRecordingId(null)
        setConflict(null)
        setReserved(null)
        return
      }
      const binding = eventToKeybinding(event, platform)
      if (!binding) return
      const reservedReason = getReservedKeybindingReason(binding, platform)
      if (reservedReason) {
        setReserved({ type: 'reserved', commandId: recordingId, binding, reason: reservedReason })
        setConflict(null)
        return
      }
      const conflicts = getConflictsForCommand(recordingId, [binding], effectiveKeybindings, platform)
      if (conflicts.length) {
        setConflict({ type: 'conflict', commandId: recordingId, binding, conflicts })
        setReserved(null)
        return
      }
      onSetKeybindings(recordingId, [binding])
      setRecordingId(null)
      setConflict(null)
      setReserved(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [effectiveKeybindings, onSetKeybindings, platform, recordingId])

  return (
    <section className="settings-block">
      <div className="settings-heading-row">
        <div>
          <h2 className="settings-block-title">{t('settings.keyboard')}</h2>
          <p className="settings-block-desc">{t('settings.keyboardDesc')}</p>
        </div>
        <button type="button" className="settings-link-btn" onClick={onResetAll}>
          {t('settings.keyboardResetAll')}
        </button>
      </div>
      {conflict && (
        <div className="settings-shortcut-conflict" role="alert">
          {shortcutIssueMessage(conflict, platform, t)}
        </div>
      )}
      {reserved && (
        <div className="settings-shortcut-conflict" role="alert">
          {shortcutIssueMessage(reserved, platform, t)}
        </div>
      )}
      <input
        className="settings-input settings-shortcut-search"
        type="search"
        spellCheck={false}
        value={query}
        placeholder={t('settings.keyboardSearch')}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="settings-shortcuts">
        {CATEGORY_ORDER.map((category) => {
          const group = commands.filter((command) => {
            if (command.category !== category) return false
            if (!normalizedQuery) return true
            const bindings = effectiveKeybindings?.[command.id] || command.defaultKeybindings || []
            const haystack = [
              command.id,
              commandCategoryLabel(category, t),
              getCommandTitle(command, t),
              ...bindings,
              ...bindings.map((binding) => keybindingToDisplay(binding, platform))
            ].join(' ').toLowerCase()
            return haystack.includes(normalizedQuery)
          })
          if (!group.length) return null
          return (
            <div className="settings-shortcut-group" key={category}>
              <div className="settings-shortcut-group-title">{commandCategoryLabel(category, t)}</div>
              <div className="settings-shortcut-list">
                {group.map((command) => {
                  const bindings = effectiveKeybindings?.[command.id] || command.defaultKeybindings || []
                  const shown = bindings.map((binding) => keybindingToDisplay(binding, platform)).filter(Boolean)
                  const customized = Object.prototype.hasOwnProperty.call(keybindingState?.overrides || {}, command.id)
                  const configurable = command.configurable !== false
                  const rowIssue = conflict?.commandId === command.id ? conflict : reserved?.commandId === command.id ? reserved : null
                  const rowIssueMessage = shortcutIssueMessage(rowIssue, platform, t)
                  return (
                    <div className={`settings-shortcut-row${rowIssue ? ' has-error' : ''}`} key={command.id}>
                      <div className="settings-shortcut-title">{getCommandTitle(command, t)}</div>
                      <div className="settings-shortcut-cell">
                        <div className="settings-shortcut-controls">
                          <button
                            type="button"
                            className={`settings-shortcut-recorder${recordingId === command.id ? ' recording' : ''}${rowIssue ? ' error' : ''}`}
                            disabled={!configurable}
                            aria-invalid={rowIssue ? 'true' : undefined}
                            aria-describedby={rowIssue ? `shortcut-error-${command.id}` : undefined}
                            onClick={() => {
                              if (!configurable) return
                              setRecordingId(command.id)
                              setConflict(null)
                              setReserved(null)
                            }}
                          >
                            {recordingId === command.id
                              ? t('settings.keyboardRecording')
                              : shown.length
                                ? shown.map((label) => <kbd key={label}>{label}</kbd>)
                                : <span className="settings-shortcut-empty">{t('settings.keyboardUnassigned')}</span>}
                          </button>
                          <button
                            type="button"
                            className="settings-shortcut-action"
                            disabled={!configurable}
                            onClick={() => onSetKeybindings(command.id, [])}
                            title={t('settings.keyboardClear')}
                          >
                            {t('settings.keyboardClear')}
                          </button>
                          {customized && configurable && (
                            <button
                              type="button"
                              className="settings-shortcut-action"
                              onClick={() => onResetCommand(command.id)}
                              title={t('settings.keyboardReset')}
                            >
                              {t('settings.keyboardReset')}
                            </button>
                          )}
                          {!configurable && <span className="settings-shortcut-fixed">{t('settings.keyboardFixed')}</span>}
                        </div>
                        {rowIssue && (
                          <div className="settings-shortcut-inline-error" id={`shortcut-error-${command.id}`} role="alert">
                            {rowIssueMessage}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
        {normalizedQuery && !commands.some((command) => {
          const bindings = effectiveKeybindings?.[command.id] || command.defaultKeybindings || []
          const haystack = [
            command.id,
            commandCategoryLabel(command.category, t),
            getCommandTitle(command, t),
            ...bindings,
            ...bindings.map((binding) => keybindingToDisplay(binding, platform))
          ].join(' ').toLowerCase()
          return haystack.includes(normalizedQuery)
        }) && (
          <div className="settings-shortcut-no-results">{t('settings.keyboardNoResults')}</div>
        )}
      </div>
      <p className="settings-shortcut-note">{t('settings.keyboardReadonlyNote')}</p>
    </section>
  )
}
