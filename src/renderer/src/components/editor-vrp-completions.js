// VRP command completions for the `vrp` code block (syntax side:
// editor-vrp-language.js). This module is loaded lazily through that language's
// dynamic import, so the editor's first paint never parses it.
//
// Typing the start of a command (`sys`, `int`, `acl`) opens a menu of VRP
// commands; Ctrl+Space with no token shows the whole table. `selectOnOpen` is
// deliberately OFF: with it on, pressing Enter right after typing a complete
// command would accept a suggestion instead of starting a new line, which is
// the wrong default for a configuration snippet.

import { autocompletion } from '@codemirror/autocomplete'
import {
  VRP_COMMANDS,
  filterVrpCommands,
  vrpLabelDisplay,
  vrpSnippetSelection,
  vrpSnippetText
} from './editor-vrp-commands.js'

// Accept a row: insert its text (placeholder markers stripped) and select the
// placeholder so the user can type straight over it.
function applyRow(insert, view, _completion, from, to) {
  view.dispatch({
    changes: { from, to, insert: vrpSnippetText(insert) },
    selection: vrpSnippetSelection(insert, from)
  })
}

function rowToOption([label, group, info, insert]) {
  const text = insert === undefined ? label : insert
  return {
    label: vrpLabelDisplay(label),
    detail: group,
    info,
    type: 'keyword',
    apply: (view, completion, from, to) => applyRow(text, view, completion, from, to)
  }
}

// Completion source: match the ASCII token before the caret; the shared
// filterVrpCommands() owns the ranking (prefix match first, then substring).
export function vrpCompletionSource(context) {
  const word = context.matchBefore(/[A-Za-z][\w-]*/)
  if (!word) {
    return context.explicit ? { from: context.pos, options: VRP_COMMANDS.map(rowToOption) } : null
  }
  if (word.from === word.to && !context.explicit) return null
  const query = context.state.sliceDoc(word.from, word.to)
  const rows = filterVrpCommands(query)
  if (!rows.length) return null
  return { from: word.from, options: rows.map(rowToOption) }
}

export const vrpCompletionExtension = autocompletion({
  override: [vrpCompletionSource],
  activateOnTyping: true,
  selectOnOpen: false
})
