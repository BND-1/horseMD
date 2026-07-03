import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Crepe, CrepeFeature } from '@milkdown/crepe'
import {
  commandsCtx,
  editorViewCtx,
  nodeViewCtx,
  prosePluginsCtx,
  remarkPluginsCtx,
  remarkStringifyOptionsCtx,
  parserCtx,
  remarkCtx
} from '@milkdown/kit/core'
import { imageBlockConfig } from '@milkdown/kit/component/image-block'
import { inlineImageConfig } from '@milkdown/kit/component/image-inline'
import { codeBlockConfig } from '@milkdown/kit/component/code-block'
import { inlineCodeSchema } from '@milkdown/kit/preset/commonmark'
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language'
import { TextSelection, Plugin } from '@milkdown/prose/state'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import '@milkdown/crepe/theme/common/link-tooltip.css'
// Latex feature styles + the KaTeX stylesheet it @imports (needed for $$…$$
// block-math preview + inline $…$ to render with correct fonts/layout).
import '@milkdown/crepe/theme/common/latex.css'
import { BLOCK_TYPES, blockById, currentBlockId } from '../blocks.js'
import { useI18n } from '../i18n.jsx'
import { copyToClipboard, fireToast } from '../ui.js'
import { renderHtmlNodeView, convertBlock, remarkMergeInlineHtml } from './editor-html.js'
import { dirOf, isRelativePath, resolveToFileUrl } from './editor-images.js'
import { inlineRichStyles } from './editor-copy.js'
import { createMermaidPreviewRenderer, createMermaidSplitPlugin } from './editor-mermaid.js'
import { tableBreakKeymap, tableCellBreakHandler, brToBreakRemarkPlugin } from './editor-tablebreak.js'
import { attachMdPasteHandler } from './editor-md-paste.js'
import { normalizeDisplayMath, createMathBlockPromotionPlugin } from './editor-math.js'
import { splitMarkdown, CHUNK_THRESHOLD, CHUNK_SIZE, appendChunks } from './editor-chunked-parse.js'
import { createToolbarScanner } from './editor-toolbar.js'
import { createBlockControls } from './editor-block-controls.js'
import remarkFrontmatter from 'remark-frontmatter'
import { frontmatterSchema, renderFrontmatterNodeView, remarkFrontmatterAnywhere } from './editor-frontmatter.js'
import { highlightFeatures, highlightStringifyHandler, toggleHighlightCommand, applyHighlightInView, HIGHLIGHT_COLORS } from './editor-highlight.js'
import {
  REVIEW_KINDS,
  applyReviewMarkupInView,
  createReviewDecorationPlugin
} from './editor-review.js'
import { normalizeReviewMarkupMarkdown } from '../reviewMarkup.js'
import { strikeInputWouldCorruptCriticMarkup } from '../strikeGuard.js'

// Reconstruct `{~~old~>new~~}` substitution markers that GFM strikethrough
// consumed during parse. remark turns `{~~old~>new~~}` into three mdast nodes:
// text("{") + <delete>old~>new</delete> + text("}"). The decoration plugin's
// strike-mark path (addParsedSubstitutionParts) then has to re-detect that
// 3-entry structure to render it — and that detection is fragile (it silently
// failed in several cases, so substitution didn't render while {++}/{--} did,
// because those scan literal text). This remark plugin merges the three nodes
// back into ONE literal text node `{~~old~>new~~}`, so substitution renders via
// the same robust text-scan path as addition/deletion. Normal strikethrough
// `~~struck~~` (no surrounding braces) is left untouched — only `{` + delete
// (containing `~>`) + `}` is reconstructed.
function remarkReconstructSubstitution() {
  const textOf = (node) => {
    if (!node) return ''
    if (node.value != null) return String(node.value)
    if (node.children) return node.children.map(textOf).join('')
    return ''
  }
  return (tree) => {
    const walk = (node) => {
      if (!node.children) return
      for (const c of node.children) walk(c)
      const kids = node.children
      const out = []
      for (let i = 0; i < kids.length; i++) {
        const a = kids[i]
        const b = kids[i + 1]
        const c = kids[i + 2]
        if (
          a && b && c &&
          a.type === 'text' && b.type === 'delete' && c.type === 'text' &&
          /\{$/.test(a.value) && /^\}/.test(c.value) &&
          textOf(b).includes('~>')
        ) {
          // a ends with `{`, b is a strikethrough containing `~>`, c starts with `}`
          // → merge into one literal `{~~old~>new~~}` text node.
          out.push({ type: 'text', value: `${a.value.slice(0, -1)}{~~${textOf(b)}~~}${c.value.slice(1)}` })
          i += 2
          continue
        }
        out.push(a)
      }
      node.children = out
    }
    walk(tree)
    return tree
  }
}

// Runtime (live-edit) BACKSTOP. PREVENTION lives in createStrikeGuardPlugin()
// (handleTextInput), but one path bypasses it: on macOS, Chinese IME commits via
// compositionend, and prosemirror-inputrules' compositionend handler re-runs
// run() with text="" — NOT through handleTextInput, so the guard never sees it.
// The strike rule then matches the marker's tildes and markRule deletes the
// marker's content + strikes a `~` (e.g. `{~~旧~>新~~}` → `{~~~>~~}` + <del>).
// (On Windows IME commit usually goes through handleTextInput, which is why the
// bug is Mac-only.) oldState still holds the intact literal marker, so this
// appendTransaction restores it. Only `{~~` (substitution) collides with the
// tilde strike rule, so only substitution markers are touched.
//
// Fast path: it's a no-op unless a transaction touched a strike mark, so normal
// typing/cursor/scroll never pay the walk cost.
function createSubstitutionLiveReconstructPlugin() {
  return new Plugin({
    appendTransaction(transs, oldState, newState) {
      if (!transs.some((tr) => tr.docChanged)) return null
      // Only run when a strike mark was added/removed (the corruption signature).
      const touchedStrike = transs.some((t) =>
        t.steps.some((s) => s.mark && s.mark.type && /strike|del/i.test(s.mark.type.name))
      )
      if (!touchedStrike) return null

      // Find textblocks where newState has a strike mark but oldState held a
      // `{~~…~~}` substitution marker that is no longer intact (the strike rule
      // ate it). Restoring the WHOLE textblock content from oldState is safe
      // because the corruption is always its own isolated transaction, so
      // oldState == newState except for the strike-rule damage.
      const toRestore = []
      // nStart/oStart = position where the node's CONTENT begins (nodePos+1; 0
      // for the root doc). Walking by content-start avoids the root-level
      // off-by-one (the doc's first child sits at pos 0, not 1).
      const walk = (nNode, oNode, nStart, oStart) => {
        if (nNode.isTextblock) {
          const nPos = nStart - 1
          if (oNode && oNode.isTextblock) {
            let hasStrike = false
            nNode.forEach((c) => {
              if (c.marks.some((m) => /strike|del/i.test(m.type.name))) hasStrike = true
            })
            if (hasStrike) {
              const oldMarkers = oNode.textContent.match(/\{~~[\s\S]*?~~\}/g) || []
              // Restore only if some old substitution marker is missing from the
              // new text (it got corrupted). Intact markers → leave alone (also
              // avoids reverting a legitimate toolbar strike on adjacent text).
              if (oldMarkers.length && !oldMarkers.every((m) => nNode.textContent.includes(m))) {
                toRestore.push({ nPos, oPos: oStart - 1, oldNode: oNode })
              }
            }
          }
          return
        }
        const count = Math.min(nNode.childCount, oNode ? oNode.childCount : 0)
        let nOff = 0
        let oOff = 0
        for (let i = 0; i < nNode.childCount; i++) {
          const nc = nNode.child(i)
          const oc = i < count && oNode ? oNode.child(i) : null
          if (oc) {
            walk(nc, oc, nStart + nOff + 1, oStart + oOff + 1)
            oOff += oc.nodeSize
          }
          nOff += nc.nodeSize
        }
      }
      walk(newState.doc, oldState.doc, 0, 0)
      if (!toRestore.length) return null

      const tr = newState.tr
      toRestore.sort((a, b) => b.nPos - a.nPos) // bottom-up so earlier positions stay valid
      for (const { nPos, oPos, oldNode } of toRestore) {
        const size = newState.doc.nodeAt(nPos).nodeSize
        tr.replaceWith(nPos + 1, nPos + size - 1, oldNode.content)
        // Keep the caret where oldState had it (e.g. right after the composed
        // char) — restored content is identical, so the offset maps 1:1.
        const head = oldState.selection.head
        if (head > oPos && head < oPos + oldNode.nodeSize) {
          tr.setSelection(TextSelection.create(tr.doc, nPos + (head - oPos)))
        }
      }
      return tr
    }
  })
}

// The definitive fix for the CriticMarkup substitution bug. The GFM
// strikethrough input rule (`~{1,2}…~{1,2}`) collides with `{~~old~>new~~}`: its
// `~>` and `~~}` tildes look like strike delimiters, AND prosemirror-inputrules'
// run() matches the regex ANYWHERE in the text-before-cursor (not just at the
// cursor), so typing ANY character on a line that holds a literal marker makes
// the rule fire and `markRule` then `tr.delete(textEnd, to)` — wiping from the
// marker to the cursor and turning the marker into strike. That is the
// "替换 corrupts / deletes my line" bug, and it is why the {++}/{--} markers
// (no tilde collision) always worked while substitution didn't.
//
// This guard runs its handleTextInput BEFORE the inputRules plugin (it is
// PREPENDED to prosePluginsCtx). It asks strikeInputWouldCorruptCriticMarkup
// whether the imminent strike match would eat a CriticMarkup marker; if so, it
// inserts the typed text LITERALLY (a programmatic transaction, which bypasses
// input rules) and returns true, so the marker survives as plain text and
// renders via the text-scan path. Plain `~~strike~~` (no CriticMarkup around)
// is untouched — the predicate returns false and normal input rules fire.
function createStrikeGuardPlugin() {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        const $from = view.state.doc.resolve(from)
        // Mirror prosemirror-inputrules' own textBefore (capped at 500 chars,
        // the same MAX_MATCH) so the predicate sees exactly what the strike
        // rule's exec() will see.
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

// Every mounted rich editor registers itself here. A rich-text tab stays mounted
// after its first activation, so several editors (and several Crepe selection
// toolbars) can coexist. The heading button injected into a toolbar resolves its
// target editor at click time — the one that currently owns the selection —
// instead of capturing a single instance, which previously made the button act
// on the wrong (hidden) tab when more than one tab was open.
const liveEditors = new Set()

// A "Mermaid" entry for the code-block language picker. Mermaid has no real
// CodeMirror language (the diagram is rendered by our own widget in
// editor-mermaid.js), so load() returns a no-op language — the picker just needs
// to offer it so users can set a block's language to "mermaid" directly, instead
// of only via the ```mermaid fence info string.
const mermaidLanguage = LanguageDescription.of({
  name: 'Mermaid',
  alias: ['mermaid', 'mmd'],
  extensions: ['mmd', 'mermaid'],
  async load() {
    return new LanguageSupport(StreamLanguage.define(() => ({ token: () => null })))
  }
})

// Localize the image-block / inline-image UI text (caption placeholder, upload
// buttons…) from the current translator. Applied at create and re-applied on a
// language switch so "Write image caption" follows the zh/en toggle.
function applyImageText(ctx, tt) {
  try {
    ctx.update(imageBlockConfig.key, (v) => ({
      ...v,
      captionPlaceholderText: tt('image.caption'),
      uploadPlaceholderText: tt('image.pasteLink'),
      uploadButton: tt('image.uploadFile'),
      confirmButton: tt('image.confirm')
    }))
    ctx.update(inlineImageConfig.key, (v) => ({
      ...v,
      uploadPlaceholderText: tt('image.pasteLink'),
      uploadButton: tt('image.upload'),
      confirmButton: tt('image.confirm')
    }))
  } catch {
    /* config not ready yet — the create-time call covers the initial value */
  }
}

// Localized labels for Crepe's slash (`/`) command menu. Without this every
// item is English regardless of the app language. Reused at editor create; a
// live language switch picks it up on the next editor mount (Crepe bakes the
// labels in at create time, so an in-place switch can't refresh the open menu).
function slashCommandConfig(tt) {
  return {
    textGroup: {
      label: tt('slash.text'),
      text: { label: tt('slash.text') },
      h1: { label: tt('block.h1') },
      h2: { label: tt('block.h2') },
      h3: { label: tt('block.h3') },
      h4: { label: tt('block.h4') },
      h5: { label: tt('block.h5') },
      h6: { label: tt('block.h6') },
      quote: { label: tt('slash.quote') },
      divider: { label: tt('slash.divider') }
    },
    listGroup: {
      label: tt('slash.list'),
      bulletList: { label: tt('slash.bullet') },
      orderedList: { label: tt('slash.ordered') },
      taskList: { label: tt('slash.task') }
    },
    advancedGroup: {
      label: tt('slash.advanced'),
      image: { label: tt('slash.image') },
      codeBlock: { label: tt('slash.code') },
      table: { label: tt('slash.table') },
      math: { label: tt('slash.math') }
    }
  }
}

/**
 * WYSIWYG editor (Milkdown Crepe) with Typora-style block-level controls.
 *
 * Ways to change a block's level — all driven through one `setBlock` path:
 *   - Keyboard:        Ctrl+1…6 → headings, Ctrl+0 → paragraph
 *   - Selection toolbar: an "H" button injected into Crepe's bold/italic
 *                        toolbar; hover it to reveal H1 / H2 / H3 / ¶
 *   - Right-click:     context menu with the full list + shortcuts
 *   - Status bar:      always-visible switcher (wired from App via onReady)
 *   - Plus Crepe's built-in slash menu (`/`) and block handle.
 */
export default function Editor({
  initialContent,
  docPath,
  imageUploadCommand,
  spellcheck,
  onChange,
  onReady,
  onActiveBlock,
  onStructureChange,
  onLoadingChange
}) {
  const { t } = useI18n()
  const tRef = useRef(t)
  tRef.current = t
  // Live mirror of the image-host upload command, read at upload time (the Crepe
  // onUpload callback is registered once at create but always uses the latest).
  const uploadCmdRef = useRef(imageUploadCommand)
  uploadCmdRef.current = imageUploadCommand
  // Live mirror of the spell-check pref: applied to view.dom on mount (below) and
  // re-applied by the effect when the pref changes.
  const spellcheckRef = useRef(spellcheck)
  spellcheckRef.current = spellcheck
  const hostRef = useRef(null)
  const viewRef = useRef(null)
  const apiRef = useRef(null)
  const crepeRef = useRef(null)
  const lastBlockRef = useRef(null)
  // Re-apply the spellcheck attribute when the pref changes after mount (the
  // initial value is set during create above).
  useEffect(() => {
    const v = viewRef.current
    if (v?.dom) v.dom.setAttribute('spellcheck', spellcheck ? 'true' : 'false')
  }, [spellcheck])
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y } viewport coords, or null
  // Floating "block level" indicator that tracks the caret (H1…H6 / Text).
  const [level, setLevel] = useState(null) // { label, kind, top, left } or null
  // Lightbox: the image src currently shown enlarged, or null.
  const [zoom, setZoom] = useState(null)
  // False until Crepe has parsed and rendered the document — drives the loading
  // skeleton. Only large documents (which actually take a moment to render) show
  // it, so small files never flash a placeholder.
  const [loaded, setLoaded] = useState(false)
  // Below this, docs parse fast enough to create synchronously. At or above it we
  // show a skeleton and defer create past a paint, so opening / switching to a
  // biggish doc shows feedback (and lets a queued click through) before the
  // synchronous ProseMirror parse blocks the main thread.
  const isLargeDoc = (initialContent?.length || 0) > 8000
  // Huge docs are split into chunks and parsed incrementally (see splitMarkdown):
  // the first chunk is the editor's initial content, the rest are appended in the
  // background after create(). `chunks` is null for normal-sized docs.
  const chunks = (initialContent?.length || 0) > CHUNK_THRESHOLD ? splitMarkdown(initialContent, CHUNK_SIZE) : null
  const firstContent = chunks ? chunks[0] : initialContent || ''

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let ready = false
    let destroyed = false
    let createRaf = 0
    const cleanups = []

    // Register this editor so a globally-injected toolbar button can find the
    // editor that currently has the selection. Getters read the live refs.
    const self = { host, getView: () => viewRef.current, getApi: () => apiRef.current }
    liveEditors.add(self)
    cleanups.push(() => liveEditors.delete(self))

    // Read an image file as a base64 data: URL — the last-resort persistent src
    // (survives save & reload, unlike a blob: URL) for untitled docs / mobile.
    const fileToDataUrl = (file) =>
      new Promise((resolve) => {
        const r = new FileReader()
        r.onload = () => resolve(r.result)
        r.onerror = () => resolve(URL.createObjectURL(file))
        r.readAsDataURL(file)
      })

    // Turn a pasted / dropped / picked image file into a *persistable* src so it
    // never dies on reload (the "screenshots lost after save & reopen" bug):
    //   1. image-host command configured → upload, use the returned URL
    //   2. saved document → write into ./assets and use a relative path (Typora)
    //   3. untitled doc / mobile / any failure → inline base64 data: URL
    const persistImage = async (file) => {
      const cmd = (uploadCmdRef.current || '').trim()
      if (cmd) {
        fireToast(tRef.current('imghost.uploading'))
        try {
          const buf = await file.arrayBuffer()
          const res = await window.api.uploadImage(cmd, file.name || 'image.png', new Uint8Array(buf))
          if (res?.ok && res.url) {
            fireToast(tRef.current('imghost.uploaded'))
            return res.url
          }
          fireToast(tRef.current('imghost.failed'))
        } catch {
          fireToast(tRef.current('imghost.failed'))
        }
        // Upload failed — fall through to local persistence so it isn't lost.
      }
      if (window.api.saveImage && docPath) {
        // Saved doc → write straight into ./assets, use a relative path.
        try {
          const buf = await file.arrayBuffer()
          const res = await window.api.saveImage(docPath, file.name || 'image.png', new Uint8Array(buf))
          if (res?.ok && res.path) return res.path
        } catch {
          /* fall through */
        }
      } else if (window.api.savePaste) {
        // Unsaved doc → park in the global paste folder and use a file:// path,
        // so it shows as a real path (not a base64 blob); it's relocated into
        // ./assets on first save (Typora-style).
        try {
          const buf = await file.arrayBuffer()
          const res = await window.api.savePaste(file.name || 'image.png', new Uint8Array(buf))
          if (res?.ok && res.url) return res.url
        } catch {
          /* fall through */
        }
      }
      return fileToDataUrl(file)
    }

    // Insert an image at the caret (used by paste / drop of image files). Persists
    // the file first, then drops an inline image node with the resulting src.
    const insertUploadedImage = async (file) => {
      const url = await persistImage(file)
      const v = viewRef.current
      if (!v || !url) return
      const imgType = v.state.schema.nodes.image
      if (!imgType) return
      const node = imgType.create({ src: url, alt: file.name || '' })
      v.dispatch(v.state.tr.replaceSelectionWith(node, false).scrollIntoView())
    }

    const crepe = new Crepe({
      root: host,
      defaultValue: normalizeReviewMarkupMarkdown(normalizeDisplayMath(firstContent)),
      features: {
        [CrepeFeature.SelectionTooltip]: true,
        [CrepeFeature.SlashCommand]: true,
        [CrepeFeature.BlockEdit]: true,
        [CrepeFeature.CodeMirror]: true,
        [CrepeFeature.Table]: true,
        [CrepeFeature.InlineCode]: true,
        [CrepeFeature.LinkTooltip]: true,
        // Render LaTeX math ($…$ / $$…$$) via KaTeX. Off by default in Crepe; the
        // KaTeX + latex styles are already bundled through the imported theme CSS.
        [CrepeFeature.Latex]: true,
        // Disable Crepe's virtual cursor: it replaces the native caret with a
        // custom element that reflows text on selection/focus (content jumps),
        // and hides the native caret (invisible in table cells). We use the
        // native caret styled via `caret-color` instead.
        [CrepeFeature.Cursor]: false
      },
      featureConfigs: {
        // Localized empty-block placeholder (replaces Crepe's "Please enter").
        [CrepeFeature.Placeholder]: { text: t('editor.placeholder'), mode: 'block' },
        // Localize the code-block "Copy" button label. (Visual feedback on click
        // is added via a delegated handler below + CSS, since Crepe gives no
        // built-in "Copied!" state.)
        [CrepeFeature.CodeMirror]: {
          copyText: t('code.copy'),
          // previewToggleText is consumed by the feature to BUILD the toggle
          // button, so it must live in the feature config (not codeBlockConfig)
          // — otherwise the Mermaid Hide/Edit label stays English.
          previewToggleText: (previewOnly) =>
            previewOnly ? t('mermaid.editCode') : t('mermaid.hideCode')
        },
        // Localize the slash (`/`) command menu (otherwise always English). The
        // slash menu is part of the BlockEdit feature (there's no SlashCommand
        // enum member), so its config lives under [BlockEdit].
        [CrepeFeature.BlockEdit]: slashCommandConfig(t)
      }
    })

    // Render raw HTML blocks (e.g. <table>…</table>) as actual HTML, like Typora.
    // Milkdown's default `html` node shows the markup as escaped text; we add a
    // ProseMirror node view that renders it instead. Display-only — the node
    // still round-trips through attrs.value, so saving keeps the original HTML.
    //
    // Register through nodeViewCtx (the shared registry Milkdown's $view uses),
    // NOT editorViewOptionsCtx.nodeViews: the core spreads editorViewOptionsCtx
    // LAST into the EditorView constructor, so setting .nodeViews there would
    // overwrite every component node view (image-block captions, CodeMirror code
    // blocks, tables, list items). Appending here merges with them.
    crepe.editor.config((ctx) => {
      ctx.update(nodeViewCtx, (views) => [
        ...views,
        ['html', (node) => renderHtmlNodeView(node)],
        ['frontmatter', (node) => renderFrontmatterNodeView(node)]
      ])
      // Localize the image caption / upload text to the current language.
      applyImageText(ctx, tRef.current)
      // Route the image-block / inline-image "Upload" button through the image
      // host. applyImageText spreads the existing config, so re-applying it on a
      // language switch preserves this onUpload.
      ctx.update(imageBlockConfig.key, (v) => ({ ...v, onUpload: persistImage }))
      ctx.update(inlineImageConfig.key, (v) => ({ ...v, onUpload: persistImage }))
      // Offer "Mermaid" in the code-block language picker (3a). Prepended so it
      // shows first; the default CodeMirror languages follow unchanged.
      // Mermaid renders via the code-block "preview" mechanism — the SAME one
      // Crepe's Latex feature uses to render $$…$$ block math as KaTeX. Both
      // register a `renderPreview`, so we CHAIN: mermaid → our renderer;
      // everything else → the previous renderPreview (Crepe's handles
      // language "latex"). Without this chain our mermaid renderer would shadow
      // latex and $$…$$ would fall back to a raw code block.
      const mermaidRender = createMermaidPreviewRenderer((k) => tRef.current(k))
      ctx.update(codeBlockConfig.key, (v) => {
        const prevRender = v.renderPreview
        return {
          ...v,
          languages: [mermaidLanguage, ...(v.languages || [])],
          renderPreview: (language, text, setPreview) => {
            if ((language || '').toLowerCase() === 'mermaid') {
              return mermaidRender(language, text, setPreview)
            }
            return prevRender ? prevRender(language, text, setPreview) : null
          },
          // Preview-only by default for blocks that HAVE a preview: mermaid +
          // latex render by default (source hidden, with a Hide/Edit toggle);
          // plain code blocks have no preview so their source always shows.
          previewOnlyByDefault: true,
          previewLabel: t('mermaid.diagram'),
          previewLoading: t('mermaid.rendering')
        }
      })
      ctx.update(prosePluginsCtx, (plugins) => [
        // CriticMarkup strike guard FIRST. ProseMirror tries plugin
        // handleTextInput props in registration order, and the GFM strikethrough
        // input rule (added by preset-gfm) would otherwise fire on a
        // substitution marker's tildes and corrupt/delete it. Prepending puts
        // this guard ahead of the inputRules plugin so it can intercept.
        createStrikeGuardPlugin(),
        ...plugins,
        // Table-cell line break (issue #7): keymap first so it wins Enter inside a cell.
        tableBreakKeymap(),
        // Rich mode parses source-readable review markers, including right-margin
        // notes for highlighted comments, while the Markdown source stays raw.
        createReviewDecorationPlugin({
          getT: (key, fallback) => {
            const value = tRef.current(key)
            return !value || value === key ? fallback : value
          },
          notify: (key, fallback) => fireToast(tRef.current(key) || fallback),
          copyText: (text, doneKey, doneFallback) =>
            copyToClipboard(text, tRef.current(doneKey) || doneFallback)
        }),
        // Split a mermaid block that holds 2+ diagrams (e.g. a 2nd paste appended
        // into the same block) back into one block per diagram.
        createMermaidSplitPlugin(),
        // Live-edit fix: convert `{`+<strike>~>..</strike>+`}` (formed when the
        // user types a substitution marker and the strikethrough input rule
        // fires) back to literal text so it renders via text-scan.
        createSubstitutionLiveReconstructPlugin(),
        // Promote typed $$…$$ (single-line) to block math. The inline-math input
        // rule fires on the first closing $; this detects the resulting
        // [text("$"), math_inline, text("$")] shape and lifts it to a latex
        // code_block. See editor-math.js.
        createMathBlockPromotionPlugin()
      ])
      // Table-cell line break — serialize a break to <br> inside a cell, and parse
      // inline <br> back into a break (see editor-tablebreak.js). Also serialize
      // the ==highlight== mark back to `==text==` (see editor-highlight.js).
      ctx.update(remarkStringifyOptionsCtx, (opts) => ({
        ...opts,
        handlers: {
          ...(opts?.handlers || {}),
          break: tableCellBreakHandler,
          highlight: highlightStringifyHandler
        }
      }))
      ctx.update(remarkPluginsCtx, (plugins) => [
        ...plugins,
        // Parse the `---` YAML block at the top of a doc into a `yaml` node
        // (handled by the frontmatter block schema), and reconstruct mangled
        // mid-doc `---` blocks (thematicBreak + Setext heading) back into yaml
        // nodes so front matter works anywhere.
        { plugin: remarkFrontmatter, options: undefined },
        { plugin: remarkFrontmatterAnywhere, options: undefined },
        { plugin: brToBreakRemarkPlugin, options: undefined },
        // Merge fragmented inline HTML (<span>x</span>) into whole fragments so
        // the html node view can render them (issue #14).
        { plugin: remarkMergeInlineHtml, options: undefined },
        // Reconstruct `{~~old~>new~~}` from the `{`+<del>+`}` GFM strikethrough
        // consumed it into, so substitution renders via text-scan (robust) not
        // the fragile strike-mark path.
        { plugin: remarkReconstructSubstitution, options: undefined }
      ])
    })

    // Issue #10: inline code "won't stop". Milkdown's inlineCode mark has no
    // `inclusive` flag, so ProseMirror defaults it to inclusive=true — typing at
    // the RIGHT boundary of `code` keeps inheriting the mark, so text after a
    // closing backtick stays code until you hard-break. Override the mark schema
    // to inclusive:false (the standard code-mark behavior, same as Typora) so the
    // caret exits the code span on the next character. Registered after Crepe's
    // commonmark preset (same id → last registration wins); nothing else about
    // the mark changes, so Markdown round-trips identically.
    crepe.editor.use(
      inlineCodeSchema.extendSchema((prev) => (ctx) => ({ ...prev(ctx), inclusive: false }))
    )
    // Issue #14: ==highlight== syntax (custom mark + two-way remark plugin).
    // Pass the array — editor.use() registers only its first arg (it wraps in
    // [...].flat()), so spreading would drop every feature after the first.
    crepe.editor.use(highlightFeatures)
    // YAML front matter (`---` block at the top) — a block node rendered as a
    // structured key/value card (see editor-frontmatter.js).
    crepe.editor.use(frontmatterSchema)
    crepeRef.current = crepe

    // Block controls (setBlock / reportActiveBlock / refreshLevel / scheduleLevel)
    // live in editor-block-controls.js; mount them here and reuse the handles.
    const { setBlock, reportActiveBlock, refreshLevel, scheduleLevel } = createBlockControls({
      viewRef,
      host,
      t: (k) => tRef.current(k),
      setLevel,
      setCtxMenu,
      onActiveBlock,
      lastBlockRef,
      cleanups
    })

    // Reflect whether the selection is highlighted onto every injected highlight
    // toolbar button (so it shows an active state, like bold/italic do). Defined
    // in the outer scope so onSelChange can call it.
    const updateHighlightActive = () => {
      const v = viewRef.current
      let active = false
      if (v && v.hasFocus()) {
        const { from, $from, empty, to } = v.state.selection
        const type = v.state.schema.marks.highlight
        if (type) {
          active = empty
            ? ($from.storedMarks || []).some((m) => m.type === type)
            : v.state.doc.rangeHasMark(from, to, type)
        }
      }
      document
        .querySelectorAll('.milkdown-toolbar .hm-highlight-item')
        .forEach((b) => b.classList.toggle('active', active))
    }

    // IMPORTANT: register listeners BEFORE create(). Crepe wires them during
    // create(), so registering afterwards means `markdownUpdated` never fires —
    // which left tab.content (outline, word count, dirty state, and saves!)
    // frozen at the initial value while the editor was actually edited.
    //
    // `appending` is set while the remaining chunks of a huge doc are being
    // parsed+inserted in the background — those dispatches fire markdownUpdated
    // too, and we must ignore them so tab.content isn't spammed with partial
    // docs. Only real user edits propagate.
    let appending = false
    crepe.on((api) => {
      api.markdownUpdated((_ctx, md) => {
        if (ready && !appending) onChange?.(normalizeReviewMarkupMarkdown(md), false)
      })
    })

    const runCreate = () =>
      crepe
        .create()
        .then(() => {
          if (destroyed) {
            crepe.destroy()
            return
          }

        // Milkdown stores the ProseMirror view in its context — `editor.view`
        // does not exist in this version, which previously left `view`
        // undefined and silently disabled every view-dependent feature.
        let view
        try {
          view = crepe.editor.ctx.get(editorViewCtx)
        } catch {
          view = crepe.editor?.view
        }
        viewRef.current = view

        // Issue #10 (belt-and-suspenders): guarantee the inline-code mark is
        // non-inclusive on the live schema, in case Crepe's plugin order left the
        // extendSchema override (above) ineffective. ResolvedPos.marks() reads
        // `mark.type.spec.inclusive === false` to drop the mark at a span's end,
        // so the caret exits `code` on the next character either way.
        try {
          const icMark = view?.state.schema.marks.inlineCode
          if (icMark && icMark.spec.inclusive !== false) icMark.spec.inclusive = false
        } catch {
          /* schema shape changed — extendSchema override still applies */
        }

        // Typora-theme hooks: most Typora themes target `#write` (the content
        // container) and `.markdown-body`. Tagging the ProseMirror element with
        // both lets a migrated Typora CSS style our editor. (Several editors can
        // be mounted at once, so `id="write"` may repeat — invalid HTML but
        // harmless: CSS `#write` still matches all, and we never getElementById it.)
        if (view?.dom) {
          view.dom.id = 'write'
          view.dom.classList.add('markdown-body')
          // English spell-check (red wavy underline) on the contenteditable.
          // Default off (settings.spellcheck). Other surfaces (source textarea,
          // inputs) opt out individually via spellCheck={false}.
          view.dom.setAttribute('spellcheck', spellcheckRef.current ? 'true' : 'false')
        }

        // Content is in the DOM now — remove the loading skeleton SYNCHRONOUSLY
        // (flushSync) so it's gone before the heavy getMarkdown + onChange work
        // below. A plain setState here would be batched and its repaint blocked by
        // that work, leaving the skeleton visibly overlapping the rendered text
        // for hundreds of ms (worse when toggling source↔rich on a big doc).
        flushSync(() => setLoaded(true))

        const onKeydown = (e) => {
          if (!(e.ctrlKey || e.metaKey) || e.altKey) return
          if (e.key >= '1' && e.key <= '6') {
            e.preventDefault()
            setBlock('h' + e.key)
          } else if (e.key === '0') {
            e.preventDefault()
            setBlock('paragraph')
          }
        }

        const onContextMenu = (e) => {
          e.preventDefault()
          // Move the caret to the click so the menu acts on the clicked block.
          const v = viewRef.current
          if (v) {
            const at = v.posAtCoords({ left: e.clientX, top: e.clientY })
            if (at) {
              const $pos = v.state.doc.resolve(at.pos)
              v.dispatch(v.state.tr.setSelection(TextSelection.near($pos)))
              reportActiveBlock()
            }
          }
          setCtxMenu({ x: e.clientX, y: e.clientY })
        }

        const onSelChange = () => {
          const v = viewRef.current
          if (!v || !v.hasFocus()) return
          reportActiveBlock()
          scheduleLevel()
          updateHighlightActive()
        }

        if (view) {
          view.dom.addEventListener('keydown', onKeydown)
          view.dom.addEventListener('contextmenu', onContextMenu)
          cleanups.push(() => view.dom.removeEventListener('keydown', onKeydown))
          cleanups.push(() => view.dom.removeEventListener('contextmenu', onContextMenu))
          // Show/hide and reposition the level badge with focus and scrolling.
          const onBlur = () => setLevel(null)
          const onFocus = () => refreshLevel()
          view.dom.addEventListener('blur', onBlur)
          view.dom.addEventListener('focus', onFocus)
          cleanups.push(() => view.dom.removeEventListener('blur', onBlur))
          cleanups.push(() => view.dom.removeEventListener('focus', onFocus))
          const scrollEl = host.closest('.editor-scroll')
          if (scrollEl) {
            // Scrolling only moves the caret's on-screen position (the caret
            // itself doesn't move), so the level badge needn't reflow every
            // 200ms mid-scroll. Refresh it ONCE after scrolling settles — this
            // drops the per-tick full-doc reflow that janked large docs (#17).
            // (Typing / selection / mouse-hover still use the leading 200ms
            // scheduleLevel above.)
            let scrollLevelTimer = 0
            const onScroll = () => {
              if (scrollLevelTimer) clearTimeout(scrollLevelTimer)
              scrollLevelTimer = setTimeout(() => {
                scrollLevelTimer = 0
                refreshLevel()
              }, 150)
            }
            scrollEl.addEventListener('scroll', onScroll, { passive: true })
            cleanups.push(() => {
              scrollEl.removeEventListener('scroll', onScroll)
              if (scrollLevelTimer) clearTimeout(scrollLevelTimer)
            })
          }
          // Re-evaluate the badge as the mouse moves (the block drag-handle shows
          // on hover) so the badge can step aside when the handle appears.
          const onMove = () => scheduleLevel()
          view.dom.addEventListener('mousemove', onMove, { passive: true })
          cleanups.push(() => view.dom.removeEventListener('mousemove', onMove))
        }
        document.addEventListener('selectionchange', onSelChange)
        cleanups.push(() => document.removeEventListener('selectionchange', onSelChange))

        // --- Ctrl/Cmd+Click a link → open in the system browser ---
        if (view) {
        const onLinkClick = (e) => {
          if (!(e.ctrlKey || e.metaKey)) return
          const a = e.target.closest?.('a')
          const href = a?.getAttribute('href')
          if (!href) return
          if (/^(https?:|mailto:)/i.test(href)) {
            e.preventDefault()
            e.stopPropagation()
            window.api.openExternal(href)
          }
        }

        // --- Rich-text copy: inject inline styles into the HTML clipboard ---
        const onCopy = (e) => {
          const sel = window.getSelection()
          if (!sel || sel.isCollapsed || !view.dom.contains(sel.anchorNode)) return
          // Let CodeMirror code blocks handle their own copy.
          if (sel.anchorNode?.parentElement?.closest?.('.cm-editor')) return
          try {
            const frag = sel.getRangeAt(0).cloneContents()
            const wrap = document.createElement('div')
            wrap.appendChild(frag)
            inlineRichStyles(wrap)
            const plain = sel.toString()
            // If the selection produced nothing meaningful (e.g. anchored in a
            // non-editable rendered HTML block), don't hijack the copy with an
            // empty payload — let the browser's default copy run.
            if (!wrap.innerHTML.trim() && !plain) return
            e.clipboardData.setData(
              'text/html',
              `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#24292f;">${wrap.innerHTML}</div>`
            )
            e.clipboardData.setData('text/plain', plain)
            e.preventDefault()
          } catch {
            /* fall back to default copy */
          }
        }

        // --- Paste / drop an image file → persist it, then insert ---
        // ProseMirror/Crepe doesn't ingest pasted or dropped image *files* by
        // default (and its own handling would yield a blob: URL that dies on
        // reload). We intercept image files and route them through persistImage:
        // image host if configured, else a local ./assets file (saved docs), else
        // an inline data: URL — so a pasted screenshot survives save & reopen.
        // Pasted/dropped text and HTML are left to the editor's own paste. Never
        // hijack a paste/drop inside a code block (CodeMirror) or input — replacing
        // the ProseMirror node selection there would clobber the block.
        const imageHandlingActive = (e) =>
          !e.target.closest?.('.cm-editor, input, textarea, .caption-input')
        const onPasteImage = (e) => {
          if (!imageHandlingActive(e)) return
          const items = e.clipboardData?.items
          if (!items) return
          const imgItem = [...items].find(
            (it) => it.kind === 'file' && it.type.startsWith('image/')
          )
          if (!imgItem) return
          const file = imgItem.getAsFile()
          if (!file) return
          e.preventDefault()
          e.stopPropagation()
          insertUploadedImage(file)
        }
        const onDropImage = (e) => {
          if (!imageHandlingActive(e)) return
          const files = [...(e.dataTransfer?.files || [])].filter((f) =>
            f.type.startsWith('image/')
          )
          if (!files.length) return
          e.preventDefault()
          e.stopPropagation()
          // Move the caret to the drop point before inserting.
          const at = view.posAtCoords({ left: e.clientX, top: e.clientY })
          if (at) {
            const $pos = view.state.doc.resolve(at.pos)
            view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
          }
          files.forEach(insertUploadedImage)
        }

        // --- Double-click an image → open it enlarged in a lightbox ---
        // Display-only: opens an overlay, never changes the document. We detect
        // the double-click ourselves (two clicks on the same image within 350ms)
        // instead of relying on the native `dblclick` event: the image-block
        // component re-renders when the first click selects it, so the two
        // physical clicks can land on different DOM nodes and no `dblclick`
        // fires. A single click is left untouched so Crepe's native image
        // interaction (select + caption editing) keeps working.
        let lastImgClick = { src: null, at: 0 }
        const onImgClick = (e) => {
          if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
          // Never treat clicks on the image-block's controls as image clicks:
          // the caption input, the caption/operation button, and the resize
          // handle must keep their own behavior (typing, toggling, resizing).
          if (
            e.target.closest?.(
              '.caption-input, .operation, .operation-item, .image-resize-handle, button, input, textarea'
            )
          )
            return
          // Match the image body itself — directly, or via the wrapper, so a
          // click still lands on the image even when it's selected and a
          // transparent overlay sits on top of it.
          const img = e.target.closest?.('img') || e.target.closest?.('.image-wrapper')?.querySelector?.('img')
          if (!img || !view.dom.contains(img)) return
          const src = img.currentSrc || img.getAttribute('src')
          if (!src) return
          const now = e.timeStamp || Date.now()
          if (lastImgClick.src === src && now - lastImgClick.at < 350) {
            e.preventDefault()
            setZoom(src)
            lastImgClick = { src: null, at: 0 }
          } else {
            lastImgClick = { src, at: now }
          }
        }

        // When the caption (operation) button is clicked, focus the caption
        // input the component reveals so the user can type the caption straight
        // away — otherwise focus stays in the editor and typing hits the body.
        const onCaptionBtn = (e) => {
          const op = e.target.closest?.('.milkdown-image-block .operation-item')
          if (!op) return
          const block = op.closest('.milkdown-image-block')
          let tries = 0
          const tryFocus = () => {
            if (destroyed) return
            const input = block?.querySelector('input.caption-input')
            if (input) {
              input.focus()
            } else if (tries++ < 12) {
              setTimeout(tryFocus, 30)
            }
          }
          setTimeout(tryFocus, 0)
        }

        // --- Code-block "Copy" button → flash the button + show a toast ---
        // Crepe copies to the clipboard itself but gives no visible feedback, so
        // a click feels unresponsive. We add a transient .hm-copied class (CSS
        // turns the label green with a ✓) and fire a global toast.
        const onCopyBtn = (e) => {
          const btn = e.target.closest?.('.copy-button')
          if (!btn || !view.dom.contains(btn)) return
          btn.classList.add('hm-copied')
          setTimeout(() => btn.classList.remove('hm-copied'), 1100)
          fireToast(tRef.current('code.copied'))
        }

        view.dom.addEventListener('click', onLinkClick, true)
        view.dom.addEventListener('click', onImgClick, true)
        view.dom.addEventListener('click', onCaptionBtn)
        view.dom.addEventListener('click', onCopyBtn, true)
        view.dom.addEventListener('copy', onCopy, true)
        view.dom.addEventListener('paste', onPasteImage, true)
        view.dom.addEventListener('drop', onDropImage, true)
        // Markdown paste (capture phase — runs before ProseMirror's handler so
        // text/html doesn't bypass us). Parses pasted Markdown source via
        // Milkdown's own remark pipeline. See editor-md-paste.js.
        cleanups.push(
          attachMdPasteHandler(view, (md) => {
            try {
              // parserCtx is a FUNCTION (text) => Doc (ParserState.create returns
              // a closure). Call it directly — it runs the full remark pipeline.
              return crepe.editor.ctx.get(parserCtx)(md)
            } catch {
              return null
            }
          })
        )
        cleanups.push(() => view.dom.removeEventListener('click', onLinkClick, true))
        cleanups.push(() => view.dom.removeEventListener('click', onImgClick, true))
        cleanups.push(() => view.dom.removeEventListener('click', onCaptionBtn))
        cleanups.push(() => view.dom.removeEventListener('click', onCopyBtn, true))
        cleanups.push(() => view.dom.removeEventListener('copy', onCopy, true))
        cleanups.push(() => view.dom.removeEventListener('paste', onPasteImage, true))
        cleanups.push(() => view.dom.removeEventListener('drop', onDropImage, true))

        // --- Resolve relative image paths against the file's folder ---
        const baseDir = dirOf(docPath)
        if (baseDir) {
          const fixImg = (img) => {
            if (img.dataset.hmResolved) return
            const raw = img.getAttribute('src') || ''
            if (!isRelativePath(raw)) return
            img.dataset.hmResolved = '1'
            img.setAttribute('src', resolveToFileUrl(baseDir, raw))
          }
          const scanImgs = (root) => {
            if (root.tagName === 'IMG') fixImg(root)
            else root.querySelectorAll?.('img').forEach(fixImg)
          }
          // Resolve everything currently in the DOM, then keep new/changed
          // images resolved as they're pasted/dropped/edited. Coalesce mutation
          // batches into ONE rAF pass (mirroring the toolbar scan below): the
          // previous per-batch loop ran a querySelectorAll sweep once per
          // mutation batch, and a burst of mutations (scrolling back into view,
          // typing on an image-heavy doc) added a measurable main-thread burst
          // — worse on Windows. fixImg is idempotent (data-hm-resolved guard),
          // so a single whole-editor sweep per frame is both correct & cheaper.
          scanImgs(view.dom)
          let imgScanRaf = 0
          const scheduleImgScan = () => {
            if (imgScanRaf) return
            imgScanRaf = requestAnimationFrame(() => {
              imgScanRaf = 0
              scanImgs(view.dom)
            })
          }
          const imgObserver = new MutationObserver(() => scheduleImgScan())
          imgObserver.observe(view.dom, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src']
          })
          cleanups.push(() => {
            if (imgScanRaf) cancelAnimationFrame(imgScanRaf)
            imgObserver.disconnect()
          })
        }

        // --- Inject custom buttons into Crepe's selection toolbar ---
        // Crepe's toolbar (bold/italic/strike…) has no submenu, so we append our
        // own items (heading picker, highlight picker, review-markup picker).
        // editor-toolbar.js owns the scan + click routing; we just mount it here.
        const { scanToolbars, cleanup: cleanupToolbarScan } = createToolbarScanner({
          liveEditors,
          self,
          t: (k) => tRef.current(k),
          updateHighlightActive
        })
        scanToolbars()
        cleanups.push(cleanupToolbarScan)
        }

        // Typora-style new document: first line is an empty Heading 1 (title),
        // with an empty paragraph below it. The title is there if you want it,
        // but the body block lets you skip the title and start writing straight
        // away (click it or press ↓). Done before the baseline below so the new
        // tab isn't marked dirty.
        if (view) {
          const { state } = view
          const doc = state.doc
          const first = doc.firstChild
          const headingType = state.schema.nodes.heading
          const paragraphType = state.schema.nodes.paragraph
          if (
            headingType &&
            paragraphType &&
            doc.childCount === 1 &&
            first &&
            first.type.name === 'paragraph' &&
            first.content.size === 0
          ) {
            let tr = state.tr.setNodeMarkup(0, headingType, { level: 1 })
            tr = tr.insert(tr.doc.content.size, paragraphType.create())
            // Leave the cursor in the title; the body paragraph is one ↓ / click away.
            tr = tr.setSelection(TextSelection.create(tr.doc, 1))
            view.dispatch(tr)
          }
        }

        // Produce a clean, inline-styled HTML snapshot of the whole document
        // for PDF export (reuses the rich-copy styling; flattens CodeMirror code
        // blocks to plain <pre><code> so they render predictably).
        const getDocHTML = () => {
          const v = viewRef.current
          if (!v) return ''
          const clone = v.dom.cloneNode(true)
          // Drop editor-only widgets so they don't end up in the PDF: code-block
          // toolbar (language picker + Copy), table handles/add/align/delete
          // buttons, block/drag handles, image resize handles, and the custom
          // list-item bullet labels (native list markers render instead).
          clone
            .querySelectorAll(
              'button, select, .language-picker, .language-list, .tools, ' +
                '.tools-button-group, .button-group, .cm-panel, .cm-tooltip, ' +
                '.preview-panel, .cell-handle, .line-handle, .handle, .add-button, ' +
                '.operation, .operation-item, .drag-preview, .milkdown-block-handle, ' +
                '.milkdown-toolbar, .image-resize-handle, .label-wrapper, .hm-frontmatter-wrap, ' +
                '.hm-review-widget, .hm-review-card'
            )
            .forEach((el) => el.remove())
          // Flatten CodeMirror editors to plain <pre><code>.
          clone.querySelectorAll('.cm-editor').forEach((cm) => {
            const lines = [...cm.querySelectorAll('.cm-line')].map((l) => l.textContent)
            const pre = document.createElement('pre')
            const code = document.createElement('code')
            code.textContent = (lines.length ? lines.join('\n') : cm.textContent).replace(/\n+$/, '')
            pre.appendChild(code)
            cm.replaceWith(pre)
          })
          // Strip editor-only attributes but keep semantic tags + src/href/alt,
          // so the print stylesheet (in the main process) fully controls the look.
          clone.querySelectorAll('*').forEach((el) => {
            el.removeAttribute('class')
            el.removeAttribute('style')
            el.removeAttribute('contenteditable')
            ;[...el.attributes].forEach((a) => {
              if (a.name.startsWith('data-') || a.name.startsWith('aria-')) el.removeAttribute(a.name)
            })
          })
          return clone.innerHTML
        }
        const getMarkdown = () => {
          try {
            return crepe.getMarkdown()
          } catch {
            return ''
          }
        }
        // Toggle ==highlight== on the selection (used by the toolbar button and
        // the Mod-Alt-H keymap). Runs through the registered command so it stays
        // in sync with ProseMirror's state.
        const toggleHighlight = () => {
          try {
            crepe.editor.ctx.get(commandsCtx).call(toggleHighlightCommand.key)
          } catch {
            /* editor tearing down */
          }
        }
        const applyReviewMarkup = (kind) => {
          const result = applyReviewMarkupInView(viewRef.current, kind)
          if (!result.ok && result.reason === 'multiline') {
            fireToast(tRef.current('review.inlineOnly'))
          }
          return result.ok
        }
        apiRef.current = { setBlock, getDocHTML, getMarkdown, toggleHighlight, applyReviewMarkup }
        // DEV-only CDP test hook (scripts/test-substitution.mjs). Exposes the
        // active editor so the harness can drive the REAL 替换 command, read
        // markdown, and simulate a markdown paste (parser + remark plugins, so
        // `{~~old~>new~~}` reconstructs like a real paste). Stripped in prod
        // builds (import.meta.env.DEV is false after `npm run build`).
        if (import.meta.env && import.meta.env.DEV) {
          window.__horsemd = Object.assign(window.__horsemd || {}, {
            getView: () => viewRef.current,
            getMarkdown,
            applyReviewMarkup,
            focus: () => {
              viewRef.current && viewRef.current.focus()
              return true
            },
            selectRange: (from, to) => {
              const v = viewRef.current
              if (!v) return 'no-view'
              v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)))
              v.focus()
              return true
            },
            clear: () => {
              const v = viewRef.current
              if (!v) return 'no-view'
              v.dispatch(v.state.tr.delete(0, v.state.doc.content.size))
              return true
            },
            cursorEnd: () => {
              const v = viewRef.current
              if (!v) return 'no-view'
              const end = v.state.doc.content.size
              v.dispatch(
                v.state.tr
                  .setSelection(TextSelection.near(v.state.doc.resolve(end), -1))
                  .scrollIntoView()
              )
              v.focus()
              return end
            },
            getHtml: () => {
              const v = viewRef.current
              return v ? v.dom.innerHTML : 'no-view'
            },
            pasteMarkdown: (md) => {
              const v = viewRef.current
              if (!v) return 'no-view'
              try {
                const parser = crepe.editor.ctx.get(parserCtx)
                const parsed = parser(md)
                const endPos = v.state.doc.content.size
                v.dispatch(v.state.tr.insert(endPos, parsed.content).scrollIntoView())
                return true
              } catch (e) {
                return 'err:' + (e && e.message ? e.message : e)
              }
            }
          })
        }
        onReady?.({
          setBlock,
          getView: () => viewRef.current,
          getDocHTML,
          getMarkdown,
          toggleHighlight,
          applyReviewMarkup
        })

        // Append the remaining chunks of a huge doc in the background so the open
        // never freezes the main thread. The editor is read-only during load to
        // avoid edit/append races; restored after. Yields via setTimeout (NOT
        // requestIdleCallback — that stops firing when the window is occluded,
        // which would leave the final yield pending and the editor read-only).
        // Compute the initial markdown snapshot (content baseline for dirty
        // tracking / outline / word count). On a big doc serializing the whole
        // document is non-trivial, so for large docs defer it past a paint —
        // setLoaded(true) above has already cleared the skeleton, so this runs
        // after the rendered content is on screen instead of holding it back.
        const finishInitial = (rebase) => {
          if (destroyed) return
          // Huge (chunked) docs skip the rebase: serializing the whole rebuilt
          // doc is itself expensive, and the original markdown is already the
          // content/savedContent baseline (clean), so no rebase is needed.
          if (rebase) {
            try { onChange?.(normalizeReviewMarkupMarkdown(crepe.getMarkdown()), true) } catch { /* */ }
          }
          ready = true
          reportActiveBlock()
        }
        if (chunks) {
          // chunks[0] is already rendered; append the rest in the background,
          // then finish (no rebase). `appending` suppresses onChange while the
          // doc streams in (see the markdownUpdated handler) — managed here, not
          // inside appendChunks, so the flag stays in this closure.
          const rest = chunks.slice(1)
          if (rest.length) appending = true
          appendChunks({
            rest,
            view,
            getParser: () => { try { return crepe.editor.ctx.get(parserCtx) } catch { return null } },
            isDestroyed: () => destroyed,
            onLoadingChange,
            onStructureChange
          }).then(() => {
            if (rest.length) appending = false
            if (!destroyed) finishInitial(false)
          })
        } else if (isLargeDoc) {
          requestAnimationFrame(() => requestAnimationFrame(() => finishInitial(true)))
        } else {
          finishInitial(true)
        }
      })
      .catch((err) => console.error('Crepe init failed', err))

    // For large docs, defer create() past a paint so the loading skeleton is
    // actually shown before create() blocks the main thread parsing/rendering —
    // otherwise switching to (or first opening) a big tab freezes on the
    // previous view with no feedback. Small docs create immediately.
    if (isLargeDoc) {
      createRaf = requestAnimationFrame(() => {
        createRaf = requestAnimationFrame(() => {
          if (!destroyed) runCreate()
        })
      })
    } else {
      runCreate()
    }

    return () => {
      destroyed = true
      if (createRaf) cancelAnimationFrame(createRaf)
      cleanups.forEach((fn) => {
        try {
          fn()
        } catch {
          /* ignore */
        }
      })
      viewRef.current = null
      crepeRef.current = null
      try {
        crepe.destroy()
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-localize the image caption / upload text when the language changes. The
  // editor isn't re-created, so we (1) update the config for images rendered
  // later, and (2) patch the placeholder on any caption inputs already in the
  // DOM — the image-block component caches the config and won't re-read it.
  useEffect(() => {
    const crepe = crepeRef.current
    if (crepe) {
      try {
        crepe.editor.action((ctx) => applyImageText(ctx, t))
      } catch {
        /* editor not ready yet */
      }
    }
    const root = hostRef.current
    if (root) {
      root.querySelectorAll('input.caption-input').forEach((inp) => {
        inp.placeholder = t('image.caption')
      })
    }
  }, [t])

  // Close the image lightbox on Escape.
  useEffect(() => {
    if (!zoom) return
    const onKey = (e) => {
      if (e.key === 'Escape') setZoom(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

  // The floating bar and context menu reuse the same conversion path as the
  // keyboard shortcuts (defined inside the effect, reached through apiRef).
  const pickBlock = (id) => apiRef.current?.setBlock(id)

  return (
    <>
      {/* Placeholder text is baked into the Crepe editor at create() and won't
          follow a language switch. Expose the current translation as a CSS var
          (re-rendered on lang change) and let CSS prefer it over the editor's
          static data-placeholder. */}
      <div
        className="editor-host"
        ref={hostRef}
        style={{ '--hm-placeholder': JSON.stringify(t('editor.placeholder')) }}
      />

      {/* Loading skeleton — pulsing gray bars shown while a large document is
          still parsing/rendering. Gated on document size so small files (which
          load instantly) never flash a placeholder. */}
      {!loaded && isLargeDoc && (
        <div className="editor-skeleton" aria-hidden="true">
          <div className="skel-line skel-title" />
          <div className="skel-line" style={{ width: '94%' }} />
          <div className="skel-line" style={{ width: '99%' }} />
          <div className="skel-line" style={{ width: '86%' }} />
          <div className="skel-line skel-gap" style={{ width: '64%' }} />
          <div className="skel-line" style={{ width: '97%' }} />
          <div className="skel-line" style={{ width: '90%' }} />
          <div className="skel-line" style={{ width: '72%' }} />
          <div className="skel-line skel-gap" style={{ width: '50%' }} />
          <div className="skel-line" style={{ width: '93%' }} />
          <div className="skel-line" style={{ width: '80%' }} />
        </div>
      )}

      {level && (
        <div
          className={`hm-level-badge hm-level-${level.kind} align-${level.align}`}
          style={{ top: level.top, left: level.x }}
          aria-hidden="true"
        >
          {level.label}
        </div>
      )}

      {ctxMenu && (
        <>
          <div className="menu-backdrop" onMouseDown={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }} />
          <div className="block-ctxmenu" style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 210),
            top: Math.min(ctxMenu.y, window.innerHeight - 320)
          }}>
            <div className="block-menu-label">{t('block.turnInto')}</div>
            {BLOCK_TYPES.map((b) => (
              <button key={b.id} className="block-menu-item" onMouseDown={(e) => e.preventDefault()} onClick={() => pickBlock(b.id)}>
                <span className="block-menu-short">{b.short}</span>
                <span className="block-menu-name">{t('block.' + b.id)}</span>
                <span className="block-menu-sc">{b.shortcut}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {zoom && (
        <div
          className="hm-image-lightbox"
          onClick={() => setZoom(null)}
          role="dialog"
          aria-modal="true"
        >
          <img src={zoom} alt="" />
          <button
            className="hm-lightbox-close"
            title={t('lightbox.close')}
            aria-label={t('lightbox.close')}
            onClick={() => setZoom(null)}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      )}
    </>
  )
}
