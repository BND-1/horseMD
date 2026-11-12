import { Crepe, CrepeFeature as Feature } from '@milkdown/crepe'
import {
  editorViewOptionsCtx,
  nodeViewCtx,
  prosePluginsCtx,
  remarkCtx,
  remarkPluginsCtx,
  remarkStringifyOptionsCtx,
  schemaCtx
} from '@milkdown/kit/core'
import { createHtmlTagInputPlugin } from './editor-html-input.js'
import { imageBlockConfig } from '@milkdown/kit/component/image-block'
import { inlineImageConfig } from '@milkdown/kit/component/image-inline'
import { codeBlockConfig } from '@milkdown/kit/component/code-block'
import { hardbreakSchema, inlineCodeSchema } from '@milkdown/kit/preset/commonmark'
import { remarkGFMPlugin, tableCellSchema, tableHeaderSchema } from '@milkdown/kit/preset/gfm'
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language'
import remarkFrontmatter from 'remark-frontmatter'
import { tabAtCursorKeymap } from './editor-codeblock-tab.js'
import { renderHtmlNodeView, remarkMergeInlineHtml } from './editor-html.js'
import { createAngleAutolinkInputPlugin, remarkUnwrapNonAsciiAutolinks } from './editor-autolink.js'
import { remarkPreserveLiteralTripleBacktickTextBlocks } from './editor-literal-backticks.js'
import { createMermaidPreviewRenderer, createMermaidSplitPlugin } from './editor-mermaid.js'
import { remarkMathBlockWithPosition } from '../lib/remark-math-block-position.js'
import { isSvgCodeLanguage, requestSvgCodeBlockScan, svgCodePreviewHtml } from './editor-svg-codeblock.js'
import {
  tableBreakKeymap,
  tableCellBreakHandler,
  brToBreakRemarkPlugin
} from './editor-tablebreak.js'
import { mathPreviewPlugin } from './editor-math-preview.js'
import { oneLineBlocksPlugin } from './editor-one-line-blocks.js'
import { listItemLeadPlugin } from './editor-list-item-lead.js'
import { listJoinPlugin } from './editor-list-join.js'
import { tableHeaderCellsPlugin } from './editor-table-header-cells.js'
import { cvKeepPlugin } from './editor-cv-keep.js'
import { compositionEndPlugin } from './editor-composition-end.js'
import { tableCellDragPlugin } from './editor-table-cell-drag.js'
import { createInlineMathEditingPlugin } from './editor-inline-math.js'
import { createSlashPlugin, disableCrepeSlash } from './editor-slash-menu.js'
import { disableCrepeLinkPreview } from './editor-link-card.js'
import { toolbarAutohidePlugin } from './editor-toolbar-autohide.js'
import { createMathBlockPromotionPlugin } from './editor-math.js'
import {
  createBlockHandleGutterPlugin,
  getBlockHandlePosition
} from './editor-block-handle-guard.js'
import { createHeadingFoldPlugin } from './editor-heading-fold.js'
import { createKatexDomPrunePlugin } from './editor-katex-dom-prune.js'
import { createInlineCodeEditingPlugin } from './editor-inline-code.js'
import { createHtmlTokenEditingPlugin } from './editor-html-token-editing.js'
import { createTaskListInputPlugin } from './editor-task-list.js'
import { createSourceTransactionDispatch } from './editor-source-transactions.js'
import { frontmatterSchema, renderFrontmatterNodeView } from './editor-frontmatter.js'
import { highlightFeatures, highlightStringifyHandler, highlightUnsafe } from './editor-highlight.js'
import { listInterruptJoin } from '../lib/list-interrupt-join.js'
import { createHtmlSpanPartPlugin, htmlSpanFeatures, htmlSpanStringifyHandler } from './editor-html-span.js'
import { createSubSupFeatures, subscriptStringifyHandler, superscriptStringifyHandler } from './editor-subsup.js'
import { createReviewDecorationPlugin } from './editor-review.js'
import { normalizeWebPasteHtml } from './editor-web-paste.js'
import { imageBlockMarkdownSchema, remarkImageBlockWithPosition } from './editor-image-markdown.js'
import { remarkStripLeadingSpaceSentinel } from '../lib/markdown-leading-space.js'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkCjkFriendlyGfmStrikethrough from '../lib/remark-cjk-strikethrough.js'
import { installInlineSerializer } from '../lib/inline-serializer.js'
import { remarkTaskParagraphPosition } from '../lib/remark-task-paragraph-position.js'
import { inlineCodeAtomsPlugin } from './editor-inline-code-atoms.js'
import { textblockNewlinesPlugin } from './editor-textblock-newlines.js'
import { createListTypeSyncPlugin } from '../lib/list-type-sync.js'
import { autolinkSafeLinkHandler, deleteStringifyHandler, emphasisStringifyHandler, safeTrailingWhitespaceTextHandler, strongStringifyHandler, tableStringifyHandler, taskListItemStringifyHandler } from '../lib/remark-text-handler.js'
import { remarkFixMarkerOffsetForBom } from '../lib/remark-marker-bom-fix.js'
import { remarkSpacedLinkDestinations } from '../lib/remark-spaced-link-destination.js'
import { remarkNormalizeCodeLineEndings } from '../lib/remark-code-line-endings.js'
import { hmLineBreakRun, serializerStyleStringifyOptions } from '../lib/serializer-style.js'
import { createTableSpanPastePlugin, pasteIntoTableCell } from './editor-table-paste.js'
import {
  createStrikeGuardPlugin,
  createSubstitutionLiveReconstructPlugin,
  remarkReconstructSubstitution
} from './editor-criticmarkup-plugins.js'

// A "Mermaid" entry for the code-block language picker. Mermaid has no real
// CodeMirror language; the picker only needs a language descriptor so users can
// choose "mermaid" directly.
const mermaidLanguage = LanguageDescription.of({
  name: 'Mermaid',
  alias: ['mermaid', 'mmd'],
  extensions: ['mmd', 'mermaid'],
  async load() {
    // StreamLanguage.define takes the stream-parser SPEC OBJECT ({token, ...}),
    // and a no-op token MUST consume the stream (readToken throws "failed to
    // advance" after 10 zero-width calls). The original factory-function spec
    // left token undefined and crashed with "token is not a function" the
    // moment a mermaid block's editor parsed — e.g. the welcome document's
    // diagram, on every build up to and including 0.13.207.
    return new LanguageSupport(StreamLanguage.define({
      token: (stream) => {
        stream.next()
        return null
      }
    }))
  }
})

export function applyImageText(ctx, tt) {
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
    /* config not ready yet */
  }
}

export function createConfiguredCrepe({
  host,
  defaultValue,
  getT,
  persistImage,
  notify,
  copyText,
  getInlineMathDeleteMode,
  markUserEdit,
  isReadOnly,
  onFrontmatterValueChange,
  onInlineCodeValueChange,
  onSlashCommand,
  onSourceTransactions,
  // () => true while source mode / a reload replaces the document.
  isProgrammaticChange = () => false,
  // (doc) => Set of lower lists the current source reads as one with the list above.
  readsAsOneList = () => new Set(),
  // () => { subscript, superscript }: Typora's `H~2~O` / `x^2^` (Settings),
  // read live.
  getMarkdownSyntax = () => ({})
}) {
  // Text blocks' marks are written by lib/inline-serializer.js (before the
  // editor creates its serializer).
  installInlineSerializer()
  const subSup = createSubSupFeatures(getMarkdownSyntax)
  const t = getT
  const platform = window.api?.platform
  const isMobile = platform === 'ios' || platform === 'android'
  const crepe = new Crepe({
    root: host,
    defaultValue,
    features: {
      // Mobile already presents the native text-selection menu. Showing Crepe's
      // toolbar at the same time creates two overlapping action surfaces and can
      // cover the selected text, so mobile keeps the native menu only.
      [Feature.SelectionTooltip]: !isMobile,
      [Feature.SlashCommand]: true,
      [Feature.BlockEdit]: true,
      [Feature.CodeMirror]: true,
      [Feature.Table]: true,
      [Feature.InlineCode]: true,
      [Feature.LinkTooltip]: true,
      [Feature.Latex]: true,
      // Disable Crepe's virtual cursor; the native caret avoids content jumps
      // and remains visible inside table cells.
      [Feature.Cursor]: false
    },
    featureConfigs: {
      [Feature.Placeholder]: { text: t('editor.placeholder'), mode: 'block' },
      [Feature.BlockEdit]: {
        blockHandle: {
          getPosition: getBlockHandlePosition,
          getOffset: () => 0
        }
      },
      [Feature.CodeMirror]: {
        copyText: t('code.copy'),
        searchPlaceholder: t('code.languageSearch'),
        noResultText: t('code.noLanguage'),
        previewToggleText: (previewOnly) =>
          previewOnly ? t('mermaid.editCode') : t('mermaid.hideCode'),
        extensions: [tabAtCursorKeymap]
      },
      [Feature.Latex]: {
        katexOptions: {
          output: window.api?.platform === 'win32' ? 'html' : 'htmlAndMathml'
        }
      }
    }
  })

  crepe.editor.config((ctx) => {
    // Neutralize Crepe's built-in slash menu (its label-only filter can't match
    // keywords, so typing past "/" made the menu vanish). Our Feishu-style menu
    // in editor-slash-menu.js replaces it. Feature.BlockEdit stays enabled so
    // the block drag/add handle (.milkdown-block-handle) is preserved.
    disableCrepeSlash(ctx)
    // One link card (editor-link-card.js) instead of Crepe's hover preview.
    disableCrepeLinkPreview(ctx)
    // Typora parity: only `~~x~~` is strikethrough. remark-gfm's default also
    // accepts a single tilde pair, so prose ranges such as `约 5~30 行……4~7 千行`
    // rendered the text between the two tildes struck through.
    ctx.set(remarkGFMPlugin.options.key, { ...ctx.get(remarkGFMPlugin.options.key), singleTilde: false })
    ctx.update(editorViewOptionsCtx, (options) => ({
      ...options,
      dispatchTransaction: createSourceTransactionDispatch(onSourceTransactions),
      transformPastedHTML: (html, view) => {
        const transformed = options.transformPastedHTML
          ? options.transformPastedHTML(html, view)
          : html
        return normalizeWebPasteHtml(transformed)
      },
      // #152: a direct prop runs before Milkdown's clipboard plugin, which
      // would replace the selection and split the surrounding table.
      handlePaste: (view, event, slice) =>
        pasteIntoTableCell(view, slice) || options.handlePaste?.(view, event, slice) || false
    }))
    ctx.update(nodeViewCtx, (views) => [
      ...views,
      ['html', (node, view, getPos) => renderHtmlNodeView(node, view, getPos)],
      ['frontmatter', (node, view, getPos) => renderFrontmatterNodeView(node, view, getPos, {
        labels: {
          edit: t('frontmatter.edit'),
          done: t('frontmatter.done'),
          input: t('frontmatter.input')
        },
        onEdit: markUserEdit,
        onValueChange: onFrontmatterValueChange,
        canEdit: () => !isReadOnly?.()
      })]
    ])

    applyImageText(ctx, getT)
    ctx.update(imageBlockConfig.key, (v) => ({ ...v, onUpload: persistImage }))
    ctx.update(inlineImageConfig.key, (v) => ({ ...v, onUpload: persistImage }))

    const mermaidRender = createMermaidPreviewRenderer(getT)
    ctx.update(codeBlockConfig.key, (v) => {
      const prevRender = v.renderPreview
      // ```svg (#166): highlighted as XML (CodeMirror's XML entry lists svg
      // only as a file extension, which the code-block loader never matches).
      const xml = (v.languages || []).find((language) => language.name === 'XML')
      const svgLanguage = xml && LanguageDescription.of({
        name: 'SVG',
        alias: ['svg'],
        extensions: ['svg'],
        load: () => xml.load()
      })
      return {
        ...v,
        languages: [mermaidLanguage, ...(svgLanguage ? [svgLanguage] : []), ...(v.languages || [])],
        renderPreview: (language, text, setPreview) => {
          // The language or text of a block changed: its 图/代码 switch follows.
          requestSvgCodeBlockScan()
          if ((language || '').toLowerCase() === 'mermaid') {
            return mermaidRender(language, text, setPreview)
          }
          if (isSvgCodeLanguage(language)) return svgCodePreviewHtml(text, t)
          return prevRender ? prevRender(language, text, setPreview) : null
        },
        previewOnlyByDefault: true,
        previewLabel: t('mermaid.diagram'),
        previewLoading: t('mermaid.rendering')
      }
    })

    ctx.update(prosePluginsCtx, (plugins) => [
      createStrikeGuardPlugin(),
      createAngleAutolinkInputPlugin(),
      // Typing the `>` of an HTML tag makes it HTML (Typora parity).
      createHtmlTagInputPlugin({ getRemark: () => ctx.get(remarkCtx), getSchema: () => ctx.get(schemaCtx) }),
      createBlockHandleGutterPlugin(ctx),
      ...plugins,
      // View-only heading folds (decorations; never written to Markdown).
      createHeadingFoldPlugin(getT),
      tableBreakKeymap(),
      // Cells and headings are one line: no soft breaks in them (#171).
      oneLineBlocksPlugin(),
      // A list item never starts with an empty paragraph + a paragraph.
      listItemLeadPlugin(),
      // Lists an edit puts next to each other join (Markdown reads them as one).
      listJoinPlugin({ isProgrammaticChange, readsAsOne: readsAsOneList }),
      tableHeaderCellsPlugin(),
      cvKeepPlugin(),
      compositionEndPlugin(),
      tableCellDragPlugin(),
      // #152: merged cells from Excel / web tables split into a plain grid.
      // A plugin, not an editorViewOptionsCtx prop: that one would replace
      // Milkdown's paste-rule runner (its empty-header-row fix runs first).
      createTableSpanPastePlugin(),
      createInlineCodeEditingPlugin({
        onEdit: markUserEdit,
        onValueChange: onInlineCodeValueChange
      }),
      // <kbd>/<samp>/<var>/<tt> edit like inline code (tags shown inside).
      createHtmlTokenEditingPlugin(),
      // Adjacent-key `part`s follow the edit (as a parse of the source would).
      createHtmlSpanPartPlugin(),
      createTaskListInputPlugin(),
      createInlineMathEditingPlugin({ getDeleteMode: getInlineMathDeleteMode }),
      createKatexDomPrunePlugin(),
      mathPreviewPlugin(getT),
      createSlashPlugin(ctx, getT, onSlashCommand),
      toolbarAutohidePlugin(),
      createReviewDecorationPlugin({
        getT: (key, fallback) => {
          const value = getT(key)
          return !value || value === key ? fallback : value
        },
        notify: (key, fallback) => notify(getT(key) || fallback),
        copyText: (text, doneKey, doneFallback) =>
          copyText(text, getT(doneKey) || doneFallback)
      }),
      createMermaidSplitPlugin(),
      createSubstitutionLiveReconstructPlugin(),
      createMathBlockPromotionPlugin(),
      createListTypeSyncPlugin(),
      inlineCodeAtomsPlugin(),
      textblockNewlinesPlugin()
    ])

    ctx.update(remarkStringifyOptionsCtx, (opts) => ({
      ...opts,
      handlers: {
        ...(opts?.handlers || {}),
        text: safeTrailingWhitespaceTextHandler,
        strong: strongStringifyHandler,
        emphasis: emphasisStringifyHandler,
        delete: deleteStringifyHandler,
        listItem: taskListItemStringifyHandler,
        link: autolinkSafeLinkHandler,
        table: tableStringifyHandler,
        break: tableCellBreakHandler,
        hmLineBreakRun,
        highlight: highlightStringifyHandler,
        hmHtmlSpan: htmlSpanStringifyHandler,
        subscript: subscriptStringifyHandler,
        superscript: superscriptStringifyHandler
      },
      // With the syntax on, a literal `^` must not pair up on reparse (`~`
      // is already escaped by GFM strikethrough's own unsafe pattern); a
      // literal `==` that could open a highlight is always escaped.
      unsafe: subSup.attachUnsafe([...(opts?.unsafe || []), highlightUnsafe]),
      join: [...(opts?.join || []), listInterruptJoin],
      // The document's own list markers, read on every compile (getters:
      // remark-stringify spreads these options per call).
      get bullet() { return serializerStyleStringifyOptions.bullet },
      get bulletOrdered() { return serializerStyleStringifyOptions.bulletOrdered }
    }))

    ctx.update(remarkPluginsCtx, (plugins) => [
      // Typora parity: `![](a b.png)` / `[x](my notes.md)` with a bare space
      // in the path. First, so a lone image still becomes an image block.
      { plugin: remarkSpacedLinkDestinations, options: undefined },
      // CRLF files: code/math values hold `\n`, like CodeMirror's edits.
      { plugin: remarkNormalizeCodeLineEndings, options: undefined },
      // Before Milkdown's remark-image-block (registered later and appended):
      // the same conversion, but the image block keeps its source position.
      { plugin: remarkImageBlockWithPosition, options: undefined },
      // Same for `$$` math blocks (Crepe's remarkMathBlock drops the position).
      { plugin: remarkMathBlockWithPosition, options: undefined },
      ...plugins,
      // CJK-friendly emphasis (Typora parity): `这是**「重点」**内容` is bold.
      // Plain CommonMark flanking rules treat CJK punctuation like ASCII
      // punctuation and leave the asterisks literal.
      { plugin: remarkCjkFriendly, options: undefined },
      // Same for strikethrough: `说「~~重点」内容~~` / `前文~~==x==~~后` (a
      // highlight or code inside) parse as struck text. Parse side only: the
      // `delete` stringify handler is ours (remark-text-handler.js).
      { plugin: remarkCjkFriendlyGfmStrikethrough, options: undefined },
      // `- [ ] **x**`: the paragraph's position starts after the checkbox.
      { plugin: remarkTaskParagraphPosition, options: undefined },
      { plugin: remarkFixMarkerOffsetForBom, options: undefined },
      { plugin: remarkStripLeadingSpaceSentinel, options: undefined },
      { plugin: remarkPreserveLiteralTripleBacktickTextBlocks, options: undefined },
      { plugin: remarkUnwrapNonAsciiAutolinks, options: undefined },
      { plugin: remarkFrontmatter, options: undefined },
      { plugin: brToBreakRemarkPlugin, options: undefined },
      { plugin: remarkMergeInlineHtml, options: undefined },
      { plugin: remarkReconstructSubstitution, options: undefined }
    ])
  })

  crepe.editor.use(
    inlineCodeSchema.extendSchema((prev) => (ctx) => ({ ...prev(ctx), inclusive: false }))
  )
  // The line break is ProseMirror's linebreak replacement: turning a code
  // block into a paragraph / heading (Mod+0, Mod+1…) makes its newlines line
  // breaks, and back. Without it the paragraph kept raw `\n` in its text,
  // which has no Markdown spelling (reads back as breaks) — the sync paused
  // on every such conversion (fuzz FORMAT seed 2).
  crepe.editor.use(
    hardbreakSchema.extendSchema((prev) => (ctx) => ({ ...prev(ctx), linebreakReplacement: true }))
  )
  // A cell's trailing line break is content (`a<br>`), but the paragraph
  // rule inside the cell drops a paragraph's last break (Milkdown
  // serializeText: right for a paragraph, whose trailing break has no
  // spelling). Such a cell writes its paragraph's content itself; the
  // table-break handler spells every break `<br>` (fuzz UI seed 128:
  // `test<br><br>` saved as `test<br>`).
  const keepTrailingCellBreak = (schema) => schema.extendSchema((prev) => (ctx) => {
    const spec = prev(ctx)
    const runner = spec.toMarkdown.runner
    return {
      ...spec,
      toMarkdown: {
        ...spec.toMarkdown,
        runner: (state, node) => {
          const paragraph = node.childCount === 1 ? node.firstChild : null
          // An empty cell is empty: the paragraph rule writes `<br />` for an
          // empty paragraph (Milkdown keeps blank lines that way), which
          // reopened as a cell holding a line break (fuzz UI seed 274).
          if (paragraph?.type.name === 'paragraph' && paragraph.content.size === 0) {
            state.openNode('tableCell')
            state.closeNode()
            return
          }
          if (paragraph?.type.name !== 'paragraph' || paragraph.lastChild?.type.name !== 'hardbreak') return runner(state, node)
          state.openNode('tableCell')
          state.openNode('paragraph')
          state.next(paragraph.content)
          state.closeNode()
          state.closeNode()
        }
      }
    }
  })
  crepe.editor.use(keepTrailingCellBreak(tableCellSchema))
  crepe.editor.use(keepTrailingCellBreak(tableHeaderSchema))
  crepe.editor.use(imageBlockMarkdownSchema)
  crepe.editor.use(subSup.parse)
  crepe.editor.use(highlightFeatures)
  crepe.editor.use(htmlSpanFeatures)
  crepe.editor.use(subSup.features)
  crepe.editor.use(frontmatterSchema)

  crepe.hmSyncSubSupUnsafe = subSup.syncUnsafe
  return crepe
}
