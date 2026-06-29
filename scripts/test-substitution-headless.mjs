// Phase 2 (deterministic headless): proves the root cause AND the fix using the
// REAL prosemirror-inputrules run() + REAL @milkdown/prose markRule + the REAL
// GFM strike regex + the REAL guard predicate. No Electron/CDP needed.
//
//   node scripts/test-substitution-headless.mjs
import { Schema } from 'prosemirror-model'
import { EditorState, Plugin, TextSelection } from 'prosemirror-state'
import { inputRules } from 'prosemirror-inputrules'
import { markRule } from '@milkdown/prose'
import { strikeInputWouldCorruptCriticMarkup } from '../src/renderer/src/strikeGuard.js'

// The EXACT regex preset-gfm registers (node_modules/@milkdown/preset-gfm:65).
const STRIKE_RE = /(?<![\w:\/])(~{1,2})(.+?)\1(?!\w|\/)/

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    text: {}
  },
  marks: { strike: { toDOM: () => ['del', 0], inclusive: true } }
})

// The real strike input rule preset-gfm adds (via $inputRule → inputRulesCtx).
const strikeRule = markRule(STRIKE_RE, schema.marks.strike)
const inputRulesPlugin = inputRules({ rules: [strikeRule] })

// Mirror of Editor.jsx createStrikeGuardPlugin() — same predicate, same literal
// insert. PREPENDED so its handleTextInput runs before inputRules.
function guardPlugin() {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        const $from = view.state.doc.resolve(from)
        const textBefore = $from.parent.textBetween(
          Math.max(0, $from.parentOffset - 500),
          $from.parentOffset,
          null,
          '￼'
        )
        if (!strikeInputWouldCorruptCriticMarkup(textBefore, text)) return false
        view.dispatch(view.state.tr.insertText(text, from, to))
        return true
      }
    }
  })
}

function makeView({ withGuard }) {
  const plugins = withGuard ? [guardPlugin(), inputRulesPlugin] : [inputRulesPlugin]
  let state = EditorState.create({
    schema,
    plugins,
    doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create())
  })
  return {
    get composing() {
      return false
    },
    get state() {
      return state
    },
    dispatch(tr) {
      state = state.apply(tr)
    }
  }
}

// Mirror ProseMirror's handleTextInput dispatch: guard first (prepend order),
// then inputRules, then default literal insert.
function typeChar(view, text) {
  const { from, to } = view.state.selection
  for (const p of view.state.plugins) {
    const h = p.spec.props && p.spec.props.handleTextInput
    if (h && h(view, from, to, text)) return
  }
  view.dispatch(view.state.tr.insertText(text, from, to))
}

function typeAt(view, text) {
  // start cursor in the (empty) paragraph
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
  for (const ch of String(text)) typeChar(view, ch)
}

function docText(view) {
  return view.state.doc.textBetween(0, view.state.doc.content.size, '\n')
}
function hasStrike(view) {
  let found = false
  view.state.doc.descendants((n) => {
    if (n.marks && n.marks.some((m) => m.type.name === 'strike')) found = true
    return !found
  })
  return found
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 160) : ''}`)
}

// ── ROOT CAUSE: WITHOUT the guard, typing the marker corrupts it (strike fires)
{
  const v = makeView({ withGuard: false })
  typeAt(v, '{~~old~>new~~}')
  const txt = docText(v)
  // Corruption = the literal marker did NOT survive AND a strike mark appeared.
  const corrupted = !/{~~old~>new~~}/.test(txt) || hasStrike(v)
  check('ROOTCAUSE no-guard: typing marker corrupts (strike fires)', corrupted, `doc=${JSON.stringify(txt)} strike=${hasStrike(v)}`)
}

// ── Scenario 3: WITH guard, typing the marker keeps it literal (renders via text-scan)
{
  const v = makeView({ withGuard: true })
  typeAt(v, '{~~old~>new~~}')
  const txt = docText(v)
  check('S3 with-guard: typed marker survives literal, no strike', txt === '{~~old~>new~~}' && !hasStrike(v), `doc=${JSON.stringify(txt)} strike=${hasStrike(v)}`)
}

// ── Scenario 1: select → 替换 command (literal insertText) → type new text
{
  const v = makeView({ withGuard: true })
  typeAt(v, '旧') // the text to replace; cursor now at pos 2
  // Mirror applyReviewMarkupInView: select the char, then insertText the marker
  // (programmatic — no input rules), place cursor after ~>.
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 2)))
  const sel = v.state.selection
  v.dispatch(v.state.tr.insertText('{~~旧~>~~}', sel.from, sel.to))
  const cursorAfterSep = sel.from + '{~~'.length + '旧'.length + '~>'.length
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, cursorAfterSep)))
  // NOW type the new text with REAL keystrokes (the bug path)
  typeChar(v, '新')
  const txt = docText(v)
  check('S1 select→替换→type keeps marker intact', txt === '{~~旧~>新~~}' && !hasStrike(v), `doc=${JSON.stringify(txt)} strike=${hasStrike(v)}`)
}

// ── Scenario 2: a literal marker already in the doc; typing AFTER it must not corrupt
{
  const v = makeView({ withGuard: true })
  // Seed the doc with the marker (as a paste would, literal text), then type after.
  v.dispatch(v.state.tr.insertText('{~~旧~>新~~}', 1))
  const after = 1 + '{~~旧~>新~~}'.length
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, after)))
  typeChar(v, '尾') // type on the same line after the marker
  const txt = docText(v)
  check('S2 typing after literal marker keeps it intact', /{~~旧~>新~~}/.test(txt) && !hasStrike(v), `doc=${JSON.stringify(txt)} strike=${hasStrike(v)}`)
}

// ── Regression: normal ~~strike~~ still becomes a strike mark
for (const [label, input] of [['double ~~', '~~hit~~'], ['single ~', '~hi~']]) {
  const v = makeView({ withGuard: true })
  typeAt(v, input)
  check(`REG normal strike ${label} still strikes`, hasStrike(v), `doc=${JSON.stringify(docText(v))} strike=${hasStrike(v)}`)
}

// ── Regression: other review markers typed are not corrupted (no strike)
for (const [label, marker] of [['addition', '{++add++}'], ['deletion', '{--del--}']]) {
  const v = makeView({ withGuard: true })
  typeAt(v, marker)
  const txt = docText(v)
  check(`REG ${label} typed intact (no strike corruption)`, txt === marker && !hasStrike(v), `doc=${JSON.stringify(txt)}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
