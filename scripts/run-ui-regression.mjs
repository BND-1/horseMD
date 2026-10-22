import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const repoRoot = process.cwd()
const fixture = (...parts) => path.join(repoRoot, 'scripts', 'fixtures', ...parts)
const realLargeDoc = '/Users/yangtingyi/vibe_everything/置身钉内/MinerU_markdown_置身钉内_14.34.50_2064164636132720640.md'
const realComputerDoc = '/Users/yangtingyi/vibe_everything/电脑档案.md'

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function runNode(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${script} failed with ${signal || code}`))
    })
  })
}

async function runSession({ name, port, profileDir, appArgs = [], tests }) {
  console.log(`\n[ui-regression] ${name}`)
  const app = await launchBuiltElectron({
    profileDir,
    port,
    appArgs
  })
  try {
    for (const test of tests) {
      await runNode(test.script, test.args || [], {
        CDP_PORT: String(port),
        ...(test.env || {})
      })
    }
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

const sessions = [
  {
    name: 'issues 57-60: LaTeX, inline code, PDF entry',
    port: 9480,
    profileDir: '/tmp/horsemd-ui-regression-57-60',
    appArgs: [fixture('issues-57-60.md')],
    tests: [{ script: 'scripts/test-issues-57-60-ui.mjs' }]
  },
  {
    name: 'PDF studio',
    port: 9481,
    profileDir: '/tmp/horsemd-ui-regression-pdf',
    appArgs: [fixture('issues-57-60.md')],
    tests: [{ script: 'scripts/test-pdf-studio-ui.mjs' }]
  },
  {
    name: 'Review UI',
    port: 9482,
    profileDir: '/tmp/horsemd-ui-regression-review',
    tests: [{ script: 'scripts/test-review-ui.mjs' }]
  },
  {
    name: 'Lightbox',
    port: 9483,
    profileDir: '/tmp/horsemd-ui-regression-lightbox',
    appArgs: [fixture('lightbox-aspect.md')],
    tests: [{ script: 'scripts/test-lightbox-ui.mjs' }]
  },
  {
    name: 'Issues 66-67: split outline and bold/sidebar shortcuts',
    port: 9485,
    profileDir: '/tmp/horsemd-ui-regression-66-67',
    appArgs: [fixture('outline-split-left.md'), fixture('outline-split-right.md')],
    tests: [{ script: 'scripts/test-issues-66-67-ui.mjs' }]
  }
]

const standalone = [
  {
    // Launches its own app (fixed 1280x820 viewport) on CDP_PORT, so it must
    // not run inside a pre-launched session on the same port.
    name: 'Table scroll and table controls',
    script: 'scripts/test-table-scroll-ui.mjs',
    env: { CDP_PORT: '9484' }
  },
  {
    name: 'Transaction-first source sync: atomic plain-text mapper',
    script: 'scripts/test-source-transaction-sync.mjs'
  },
  {
    name: 'Transaction-first source sync: plain paragraph, quote, and list edits',
    script: 'scripts/test-transaction-source-sync-ui.mjs'
  },
  {
    name: 'Background CDP: no native focus and per-character input',
    script: 'scripts/test-background-cdp-ui.mjs'
  },
  {
    name: 'Source textarea fidelity: CRLF, BOM, mixed EOL and offset mapping',
    script: 'scripts/test-source-text-fidelity.mjs'
  },
  {
    name: 'Durability boundary: delayed rich transactions settle before fail-closed recovery',
    script: 'scripts/test-editor-flush-settle.mjs'
  },
  {
    name: 'Source-sync recovery: persistent ambiguity writes only a separate recovery copy',
    script: 'scripts/test-source-sync-recovery.mjs'
  },
  {
    name: 'Real IME composition: committed CJK survives source switching',
    script: 'scripts/test-ime-source-fidelity-ui.mjs'
  },
  {
    name: 'Rich/source pause families: quote marks/soft breaks, table cells, Enter before inline code',
    script: 'scripts/test-rich-source-pause-families-ui.mjs'
  },
  {
    name: 'Source reprint engine (R1): authored bytes survive structural reprint',
    script: 'scripts/test-source-reprint-ui.mjs'
  },
  {
    name: 'Empty paragraph source: emptied paragraph keeps its line (Typora parity)',
    script: 'scripts/test-empty-paragraph-source-ui.mjs'
  },
  {
    name: 'Single tilde: `5~30` ranges stay plain, only ~~x~~ strikes (Typora parity)',
    script: 'scripts/test-single-tilde-strike-ui.mjs'
  },
  {
    name: 'Full-screen mode: shell hidden, document editable, Esc/shortcut/corner exit',
    script: 'scripts/test-immersive-mode-ui.mjs'
  },
  {
    name: 'Image pasted into a text paragraph (empty title = no title)',
    script: 'scripts/test-image-paste-paragraph-ui.mjs'
  },
  {
    name: 'Image pasted on a new empty line (Enter, then paste)',
    script: 'scripts/test-image-paste-empty-line-ui.mjs'
  },
  {
    name: 'Video / audio / iframe embeds (render, play, drop a file)',
    script: 'scripts/test-media-embed-ui.mjs'
  },
  {
    name: 'Edge hard break in a typed-from-scratch document',
    script: 'scripts/test-edge-hard-break-scratch-ui.mjs'
  },
  {
    name: 'URL typing: bare URLs and <url> save byte-exact without a pause',
    script: 'scripts/test-url-typing-ui.mjs'
  },
  {
    name: 'Context copy: tables copy as tab-separated rows with clean HTML',
    script: 'scripts/test-context-copy-ui.mjs'
  },
  {
    name: 'Find bar open: an edit then a rich→source switch keeps the caret at the edit',
    script: 'scripts/test-find-open-mode-switch-ui.mjs'
  },
  {
    name: '#151 cell copy: partial cell text copies without the table',
    script: 'scripts/test-issue-151-cell-copy-ui.mjs'
  },
  {
    name: '#152 table paste: merged cells and pastes inside a cell keep a savable grid',
    script: 'scripts/test-table-paste-ui.mjs'
  },
  {
    name: 'List / quote partial copy: text inside one paragraph copies without its marker',
    script: 'scripts/test-list-partial-copy-ui.mjs'
  },
  {
    name: 'Code-block language picker accepts any typed language name',
    script: 'scripts/test-codeblock-custom-language-ui.mjs'
  },
  {
    name: 'PDF: a table with blank body rows keeps full row height',
    script: 'scripts/test-pdf-empty-table-rows-ui.mjs'
  },
  {
    name: 'Typora themes (#154): @import, ?t= fonts, bare element rules, raw <img>, white default page',
    script: 'scripts/test-custom-theme-typora-base-ui.mjs'
  },
  {
    name: 'Typora parity: image/link paths with bare spaces render; edits keep authored bytes',
    script: 'scripts/test-spaced-image-path-ui.mjs'
  },
  {
    name: 'CRLF file: Enter in a new or authored code block stays in sync, file stays CRLF',
    script: 'scripts/test-crlf-code-block-enter-ui.mjs'
  },
  {
    name: 'Blockquote transients: space+Enter, pending text+Enter, empty fill, quote-list tail',
    script: 'scripts/test-blockquote-transient-trace-regressions-ui.mjs'
  },
  {
    name: 'Blockquote list exit chain: Enter/exit/nested and bullet Backspace (CRLF+BOM)',
    script: 'scripts/test-blockquote-list-exit-backspace-chain-ui.mjs'
  },
  {
    name: 'Editor-only document changes and journal locality helpers (pure)',
    script: 'scripts/test-editor-only-document.mjs'
  },
  {
    name: 'Blockquote inline patch and BOM marker fix (pure)',
    script: 'scripts/test-blockquote-inline-patch.mjs'
  },
  {
    name: 'Remark marker offset in BOM files (pure)',
    script: 'scripts/test-remark-marker-bom-fix.mjs'
  },
  {
    name: 'Auto-save: settings enable, rich/source debounce, external-change guard',
    script: 'scripts/test-autosave-ui.mjs'
  },
  {
    name: 'Diverged Markdown: paragraph and nested-list edits save directly without normalization',
    script: 'scripts/test-diverged-ordinary-save-ui.mjs'
  },
  {
    name: 'Issue 93: inline code editing boundaries and literal backticks',
    script: 'scripts/test-inline-code-ui.mjs'
  },
  {
    name: 'Issue 98: native code copy, Markdown copy, undo, and session restore preference',
    script: 'scripts/test-issue-98-copy-undo-ui.mjs'
  },
  {
    name: 'Issue 98: disabled session restore still accepts explicit startup files',
    script: 'scripts/test-session-restore-setting-ui.mjs'
  },
  {
    name: 'Issues 70-72: outline fold state and task list input',
    script: 'scripts/test-issues-70-72-ui.mjs'
  },
  {
    name: 'Task list: checkbox state saves and survives reopen',
    script: 'scripts/test-task-list-persistence-ui.mjs'
  },
  {
    name: 'Issues 74-75: inline math deletion and font picker names',
    script: 'scripts/test-issues-74-75-ui.mjs'
  },
  {
    name: 'Editor style settings: source font and custom CSS preview',
    script: 'scripts/test-editor-style-settings-ui.mjs'
  },
  {
    name: 'PDF LaTeX: display math prints rendered output',
    script: 'scripts/test-pdf-latex-ui.mjs'
  },
  {
    name: 'PDF rendered formats: Mermaid and structural Markdown',
    script: 'scripts/test-pdf-rendered-formats-ui.mjs'
  },
  {
    name: 'Mermaid paste: one clipboard diagram maps to one block and preview',
    script: 'scripts/test-mermaid-paste-ui.mjs'
  },
  {
    name: 'PDF preview churn: rapid settings stay serialized on a long document',
    script: 'scripts/test-pdf-preview-churn-ui.mjs'
  },
  {
    name: 'PDF images: local and remote resources stage for printing',
    script: 'scripts/test-pdf-images-ui.mjs'
  },
  {
    name: 'PDF tables: editor column proportions survive export',
    script: 'scripts/test-pdf-table-layout-fidelity-ui.mjs'
  },
  {
    name: 'Issue 77: localized rich edits preserve original Markdown spelling',
    script: 'scripts/test-issue-77-source-preservation-ui.mjs'
  },
  {
    name: 'Paragraph source preservation: compact lines and Enter survive reopen',
    script: 'scripts/test-paragraph-source-preservation-ui.mjs'
  },
  {
    name: 'New Markdown source fidelity: typed list markers and empty paragraphs',
    script: 'scripts/test-new-markdown-source-fidelity-ui.mjs'
  },
  {
    name: 'List conversion source fidelity: immediate typing, save, and full reopen',
    script: 'scripts/test-list-conversion-source-fidelity-ui.mjs'
  },
  {
    name: 'Soft line breaks: visual lines preserve source bytes and explicit hard breaks',
    script: 'scripts/test-soft-line-breaks-ui.mjs'
  },
  {
    name: 'Mode switch raw offsets: hard breaks, inline atoms, and immediate input',
    script: 'scripts/test-mode-switch-raw-offset-ui.mjs'
  },
  {
    name: 'Source fidelity audit: heterogeneous Markdown stays byte-local',
    script: 'scripts/test-source-fidelity-audit-ui.mjs'
  },
  {
    name: 'Large source fidelity: chunked CRLF/BOM document keeps its first rich edit',
    script: 'scripts/test-large-doc-source-preservation-ui.mjs'
  },
  {
    name: 'Large-document classification and content-visibility gating',
    script: 'scripts/test-rich-cv-gating.mjs'
  },
  {
    name: 'Issue 79: list spacing follows typography settings',
    script: 'scripts/test-issue-79-list-spacing-ui.mjs'
  },
  {
    name: 'Issue 82: outline heading sections reorder together',
    script: 'scripts/test-issue-82-outline-reorder-ui.mjs'
  }
]

if (await exists(realLargeDoc)) {
  sessions.push(
    {
      name: 'Large document mode switch 10x',
      port: 9486,
      profileDir: '/tmp/horsemd-ui-regression-large-switch',
      appArgs: [realLargeDoc],
      tests: [{ script: 'scripts/test-mode-switch-10x.mjs' }]
    },
    {
      name: 'Large document source find',
      port: 9487,
      profileDir: '/tmp/horsemd-ui-regression-source-find',
      appArgs: [realLargeDoc],
      tests: [{
        script: 'scripts/test-source-find.mjs',
        args: ['--mode-switch'],
        env: { FIND_QUERY: '企业' }
      }]
    }
  )
} else {
  console.warn(`[ui-regression] skip real large document: ${realLargeDoc}`)
}

if (await exists(realComputerDoc)) {
  sessions.push({
    name: '电脑档案 mode switch chains',
    port: 9488,
    profileDir: '/tmp/horsemd-ui-regression-computer-switch',
    appArgs: [realComputerDoc],
    tests: [{
      script: 'scripts/test-mode-switch-chains.mjs',
      env: { CHAIN_RATIOS: '0.2,0.5,0.8' }
    }]
  })
} else {
  console.warn(`[ui-regression] skip real computer document: ${realComputerDoc}`)
}

// HM_KEEP_GOING=1 runs everything and reports every failure at the end; the
// default stops at the first failure.
const keepGoing = process.env.HM_KEEP_GOING === '1'
const failed = []
const attempt = async (name, run) => {
  try {
    await run()
  } catch (error) {
    if (!keepGoing) throw error
    failed.push(name)
    console.error(`KEEPGOING-FAIL ${name} ${error?.message || error}`)
  }
}

for (const session of sessions) {
  await attempt(session.name, () => runSession(session))
}

for (const item of standalone) {
  console.log(`\n[ui-regression] ${item.name}`)
  await attempt(item.name, () => runNode(item.script, [], item.env))
}

if (failed.length) {
  console.error(`KEEPGOING-SUMMARY failed=${JSON.stringify(failed)}`)
  process.exit(1)
}
console.log(`\nPASS UI regression: ${sessions.length} sessions + ${standalone.length} standalone`)
