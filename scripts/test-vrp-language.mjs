// Pure Node regression for the `vrp` code-block language — no Electron, no DOM.
//
// Covers the three things that can silently regress:
//   1. the StreamLanguage tokenizer (comment / keyword / interface / IP / prompt)
//   2. the command table contract (typeable ASCII label, balanced placeholders,
//      unique labels, the alias rule Milkdown's LanguageLoader depends on)
//   3. filterVrpCommands ranking (prefix first, substring fallback)
//
// Run: node scripts/test-vrp-language.mjs
import assert from 'node:assert/strict'

import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

import { vrpLanguage, vrpStreamLanguage } from '../src/renderer/src/components/editor-vrp-language.js'
import {
  VRP_COMMANDS,
  filterVrpCommands,
  vrpLabelDisplay,
  vrpLabelToken,
  vrpSnippetSelection,
  vrpSnippetText
} from '../src/renderer/src/components/editor-vrp-commands.js'

let checks = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
}

// ---- 1. tokenizer ----
const doc = [
  '# VLAN 10 网关',
  'system-view',
  'sysname SW-CORE-01',
  '[Huawei]interface Vlanif10',
  ' ip address 192.168.10.1 255.255.255.0',
  ' undo shutdown'
].join('\n')

const state = EditorState.create({ doc, extensions: [vrpStreamLanguage] })
const tokens = []
syntaxTree(state).iterate({
  enter(node) {
    if (node.name === 'Document') return
    tokens.push(`${node.name}:${doc.slice(node.from, node.to)}`)
  }
})

ok(tokens.includes('comment:# VLAN 10 网关'), `comment token missing: ${tokens.join(' | ')}`)
ok(tokens.includes('keyword:system-view'), 'system-view should tokenize as keyword')
ok(tokens.includes('keyword:sysname'), 'sysname should tokenize as keyword')
ok(tokens.includes('keyword:undo'), 'undo should tokenize as keyword')
ok(tokens.includes('meta:[Huawei]'), 'device prompt should tokenize as meta')
ok(tokens.includes('typeName:Vlanif10'), 'Vlanif10 should tokenize as an interface name')
ok(tokens.includes('atom:192.168.10.1'), 'IPv4 address should tokenize as atom')
ok(tokens.includes('variableName:SW-CORE-01'), 'hostname should tokenize as variableName')
// End-of-line handling: the last line must terminate (no infinite tokenizer loop).
ok(tokens.length > 0 && tokens.every((entry) => entry.includes(':')), 'malformed token list')

// ---- 2. table contract ----
ok(vrpLanguage.alias.includes(vrpLanguage.name.toLowerCase()), 'alias must contain the lowercase name (Milkdown LanguageLoader matches aliases only)')
ok(vrpLanguage.alias.includes('vrp'), "fence language 'vrp' must be an alias")

const seen = new Set()
for (const row of VRP_COMMANDS) {
  const [label, group, info, insert] = row
  ok(vrpLabelToken(label).length > 0, `label needs a typeable ASCII prefix: ${label}`)
  ok(typeof group === 'string' && group.length > 0, `missing group: ${label}`)
  ok(typeof info === 'string' && info.length > 0, `missing info: ${label}`)
  const text = insert === undefined ? label : insert
  const opens = (text.match(/«/g) || []).length
  const closes = (text.match(/»/g) || []).length
  ok(opens === closes, `unbalanced placeholder markers: ${label}`)
  // Several pairs are allowed (multi-parameter commands); the FIRST pair is the
  // selection and the remaining ones land as plain text.
  const rowSel = vrpSnippetSelection(text, 0)
  if (opens > 0) {
    ok(rowSel.head > rowSel.anchor, `first placeholder must be selected: ${label}`)
  } else {
    ok(rowSel.anchor === vrpSnippetText(text).length, `caret must land after the text: ${label}`)
  }
  const display = vrpLabelDisplay(label)
  ok(!seen.has(display), `duplicate completion label: ${display}`)
  seen.add(display)
  if (insert !== undefined) {
    ok(insert.includes('\n'), `multi-line inserts are templates; single-line rows use the label: ${label}`)
  }
}

// Snippet markers -> text + selection.
ok(vrpSnippetText('sysname «HOST»') === 'sysname HOST', 'markers must be stripped from inserted text')
const sel = vrpSnippetSelection('sysname «HOST»', 100)
ok(sel.anchor === 108 && sel.head === 112, `placeholder should be selected: ${JSON.stringify(sel)}`)
ok(vrpSnippetSelection('save', 10).anchor === 14, 'plain rows place the caret after the command')

// ---- 3. filtering ----
ok(filterVrpCommands('').length === VRP_COMMANDS.length, 'empty query returns the full table')
const sysRows = filterVrpCommands('sys')
ok(sysRows.some((row) => row[0] === 'system-view'), "'sys' should find system-view")
ok(sysRows.some((row) => row[0].startsWith('sysname')), "'sys' should find sysname")
ok(sysRows.every((row) => vrpLabelToken(row[0]).startsWith('sys')), 'prefix hits must rank first')
const ipRows = filterVrpCommands('192.168')
ok(
  ipRows.some((row) => row[0].startsWith('ip address')),
  'substring fallback should find ip address rows'
)
ok(filterVrpCommands('int').some((row) => vrpLabelToken(row[0]) === 'interface'), "'int' should find interface commands")
ok(filterVrpCommands('vlanif').length > 0, "'vlanif' should find the VLANIF rows")

console.log(`vrp language: ${checks} checks passed`)
