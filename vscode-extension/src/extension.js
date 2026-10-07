// HorseMD VSCode extension — WYSIWYG editor via Custom Editor API.
// Opening a .md file opens the Milkdown Crepe editor (no command needed).
// Edits sync to the TextDocument; VSCode handles save/dirty state.
// All resources bundled locally — no CDN dependency.

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')

// Per-document state, keyed by uri.toString()
const docStates = new Map()

class HorsemdEditorProvider {
  openCustomDocument(uri) {
    return { uri, dispose() {} }
  }

  async resolveCustomEditor(document, panel) {
    const key = document.uri.toString()

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: getLocalResourceRoots(document.uri)
    }

    const cfg = vscode.workspace.getConfiguration('horsemd')

    // Read initial content from the TextDocument
    let initialContent = ''
    try {
      const doc = await vscode.workspace.openTextDocument(document.uri)
      initialContent = doc.getText()
    } catch {
      try { initialContent = fs.readFileSync(document.uri.fsPath, 'utf8') } catch {}
    }

    panel.webview.html = getHtml(panel.webview)

    const state = {
      ready: false,
      pendingInit: {
        content: initialContent,
        theme: cfg.get('theme') || 'auto',
        fontSize: cfg.get('fontSize') || 16,
        contentWidth: cfg.get('contentWidth') || 'standard',
        showOutline: cfg.get('showOutline') !== false,
      },
      isWebviewEditing: false,
      pendingEdit: null,
      disposed: false,
      debounceTimer: null,
      saveTimer: null,
    }
    docStates.set(key, { panel, state })

    // ===== Webview → Document =====
    const msgDisposable = panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        state.ready = true
        panel.webview.postMessage({ type: 'init', ...state.pendingInit })
        state.pendingInit = null
      } else if (msg.type === 'edit') {
        if (state.disposed || !state.ready) return
        if (state.isWebviewEditing) { state.pendingEdit = msg.markdown; return }
        state.isWebviewEditing = true
        try {
          await updateDocument(document.uri, msg.markdown)
          while (state.pendingEdit && !state.disposed) {
            const pending = state.pendingEdit
            state.pendingEdit = null
            await updateDocument(document.uri, pending)
          }
          // Debounced auto-save (off by default; 2s delay when on)
          if (cfg.get('autoSave') === true) {
            clearTimeout(state.saveTimer)
            state.saveTimer = setTimeout(async () => {
              if (state.disposed) return
              try {
                const doc = await vscode.workspace.openTextDocument(document.uri)
                await doc.save()
              } catch {}
            }, 2000)
          }
        } catch {}
        state.isWebviewEditing = false
      } else if (msg.type === 'switchTheme') {
        await vscode.workspace.getConfiguration('horsemd').update('theme', msg.theme, vscode.ConfigurationTarget.Global)
        for (const { panel: p } of docStates.values()) p.webview.postMessage({ type: 'theme', theme: msg.theme })
      } else if (msg.type === 'toggleOutline') {
        for (const { panel: p } of docStates.values()) p.webview.postMessage({ type: 'toggleOutline' })
      }
    })

    // ===== Document → Webview (external edits, undo/redo) =====
    const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== key) return
      if (state.isWebviewEditing || state.disposed || !state.ready) return
      clearTimeout(state.debounceTimer)
      state.debounceTimer = setTimeout(() => {
        if (state.disposed) return
        try {
          const content = e.document.getText()
          panel.webview.postMessage({ type: 'update', content })
        } catch {}
      }, 150)
    })

    const themeDisposable = vscode.window.onDidChangeActiveColorTheme(() => {
      if (!state.disposed) panel.webview.postMessage({ type: 'colorThemeChanged' })
    })

    panel.onDidDispose(() => {
      state.disposed = true
      clearTimeout(state.debounceTimer)
      clearTimeout(state.saveTimer)
      msgDisposable.dispose()
      changeDisposable.dispose()
      themeDisposable.dispose()
      docStates.delete(key)
    })
  }
}

async function updateDocument(uri, markdown) {
  const doc = await vscode.workspace.openTextDocument(uri)
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
  const edit = new vscode.WorkspaceEdit()
  edit.replace(uri, fullRange, markdown)
  await vscode.workspace.applyEdit(edit)
}

function getLocalResourceRoots(uri) {
  const roots = [vscode.Uri.file(path.dirname(uri.fsPath))]
  const extDir = vscode.Uri.file(path.join(__dirname, '..'))
  roots.push(extDir)
  const ws = vscode.workspace.workspaceFolders
  if (ws) roots.push(ws[0].uri)
  return roots
}

function activate(context) {
  const provider = new HorsemdEditorProvider()

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'horsemd.editor',
      provider,
      {
        webviewOptions: {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  )

  const switchTheme = async () => {
    const themes = [
      { id: 'auto', label: 'Auto — Follow VSCode' },
      { id: 'light', label: 'Warm Light  暖光' },
      { id: 'dark', label: 'Warm Dark  暖夜' },
      { id: 'morandi', label: 'Morandi Sage  莫兰迪·灰绿' },
      { id: 'morandi-rose', label: 'Morandi Rose  莫兰迪·豆沙' },
      { id: 'morandi-blue', label: 'Morandi Mist  莫兰迪·雾蓝' },
      { id: 'morandi-dark', label: 'Morandi Dusk  莫兰迪·暮' }
    ]
    const pick = await vscode.window.showQuickPick(
      themes.map((t) => ({ label: t.label, id: t.id })),
      { placeHolder: 'Select HorseMD theme' }
    )
    if (!pick) return
    await vscode.workspace.getConfiguration('horsemd').update('theme', pick.id, vscode.ConfigurationTarget.Global)
    for (const { panel } of docStates.values()) panel.webview.postMessage({ type: 'theme', theme: pick.id })
  }

  const toggleOutline = () => {
    for (const { panel } of docStates.values()) panel.webview.postMessage({ type: 'toggleOutline' })
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('horsemd.switchTheme', switchTheme),
    vscode.commands.registerCommand('horsemd.toggleOutline', toggleOutline)
  )
}

function getHtml(webview) {
  const csp = webview.cspSource
  const nonce = getNonce()

  const editorJs = webview.asWebviewUri(vscode.Uri.file(
    path.join(__dirname, '..', 'media', 'editor.js')
  ))
  const editorCss = webview.asWebviewUri(vscode.Uri.file(
    path.join(__dirname, '..', 'media', 'editor.css')
  ))

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: ${csp} blob:; style-src 'unsafe-inline' ${csp}; script-src ${csp}; font-src data: ${csp};">
  <link rel="stylesheet" href="${editorCss}">
  <style>${getThemeCSS()}</style>
</head>
<body class="vscode-body">
  <div id="hm-app">
    <aside id="hm-outline" class="hm-outline"></aside>
    <main id="hm-scroll" class="hm-scroll">
      <div id="editor"></div>
    </main>
  </div>
  <script nonce="${nonce}" src="${editorJs}"></script>
</body>
</html>`
}

function getThemeCSS() {
  return `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body { font-family: var(--font-write); color: var(--text); background: var(--bg); overflow: hidden; -webkit-font-smoothing: antialiased; }
#hm-app { display: flex; height: 100vh; overflow: hidden; }
#hm-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; scroll-behavior: smooth; overscroll-behavior: contain; }
.hm-hidden { display: none !important; }

:root {
  --font-write: 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB', 'Source Han Sans SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', Consolas, 'Courier New', monospace;
  --radius-sm: 5px; --radius-md: 8px; --ease-out: cubic-bezier(0.22, 1, 0.36, 1); --dur-fast: 0.14s; --shadow-float: 0 4px 16px rgba(0,0,0,0.12); --editor-block-space: 1.35em; --editor-block-radius: var(--radius-md); --editor-subtle-surface: var(--code-bg); --editor-para-spacing: 0.8em; --hover: var(--hover-elevated);
}

/* Theme palettes (from HorseMD app.css) */
body.light, body.vscode-light.light { --bg:#ebe7e0; --bg-elevated:#faf8f5; --bg-sidebar:#e3dfd7; --bg-editor:#fdfbf7; --text:#2a2620; --text-strong:#0f0d0a; --muted:#5a5650; --faint:#8a867e; --border:#c8c4bc; --border-soft:#ddd9d2; --hover-elevated:#f0ede5; --code-bg:#f2efe8; --code-border:#ddd9d2; --code-block-bg:#2a2730; --code-block-border:rgba(0,0,0,0.25); --code-linenum:#8a867e; --code-linenum-border:rgba(255,255,255,0.08); --code-linenum-active:#c8c4bc; --accent:#c86b35; --accent-strong:#a04f22; --accent-soft:rgba(200,107,53,0.15); --danger:#c93b3b; }
body.dark, body.vscode-dark.dark { --bg:#16130e; --bg-elevated:#1e1a16; --bg-sidebar:#191512; --bg-editor:#1d1914; --text:#d0c8bc; --text-strong:#f2ebe0; --muted:#8a8378; --faint:#6a655c; --border:#3a3630; --border-soft:#302c28; --hover-elevated:#2e2a24; --code-bg:#24201c; --code-border:#3a3630; --code-block-bg:#100e0b; --code-block-border:rgba(255,255,255,0.06); --code-linenum:#6a655c; --code-linenum-border:rgba(255,255,255,0.06); --code-linenum-active:#8a8378; --accent:#e69055; --accent-strong:#ffb080; --accent-soft:rgba(230,144,85,0.18); --danger:#ff7070; }
body.theme-morandi { --bg:#e7e8e2; --bg-elevated:#f3f4ef; --bg-sidebar:#dfe1d9; --bg-editor:#f6f7f2; --text:#3a3d35; --text-strong:#23261f; --muted:#6c6f63; --faint:#97998d; --border:#c5c8bc; --border-soft:#d9dbd0; --hover-elevated:#ecede6; --code-bg:#eceee6; --code-border:#d9dbd0; --code-block-bg:#2a2730; --code-block-border:rgba(0,0,0,0.25); --accent:#7d8a6a; --accent-strong:#5f6b4e; --accent-soft:rgba(125,138,106,0.16); --danger:#b3645f; }
body.theme-morandi-rose { --bg:#ece5e2; --bg-elevated:#f6f1ef; --bg-sidebar:#e5ddd9; --bg-editor:#f8f4f2; --text:#423a37; --text-strong:#271f1c; --muted:#70645f; --faint:#9c918b; --border:#ccc1bc; --border-soft:#ddd4cf; --hover-elevated:#efe8e5; --code-bg:#efe8e5; --code-border:#ddd4cf; --code-block-bg:#2a2730; --code-block-border:rgba(0,0,0,0.25); --accent:#a8807b; --accent-strong:#855e59; --accent-soft:rgba(168,128,123,0.18); --danger:#b85c57; }
body.theme-morandi-blue { --bg:#e4e7ea; --bg-elevated:#f1f3f5; --bg-sidebar:#dce0e4; --bg-editor:#f5f7f8; --text:#383d42; --text-strong:#1f242a; --muted:#656d74; --faint:#939ba2; --border:#c2c8ce; --border-soft:#d6dade; --hover-elevated:#eaedf0; --code-bg:#e9edf0; --code-border:#d6dade; --code-block-bg:#2a2730; --code-block-border:rgba(0,0,0,0.25); --accent:#7e94a6; --accent-strong:#5d7385; --accent-soft:rgba(126,148,166,0.18); --danger:#b3645f; }
body.theme-morandi-dark { --bg:#21242b; --bg-elevated:#282c34; --bg-sidebar:#23262d; --bg-editor:#262a31; --text:#c3c7cd; --text-strong:#e7eaef; --muted:#878c95; --faint:#5f636b; --border:#3a3f49; --border-soft:#313640; --hover-elevated:#2e333c; --code-bg:#2b2f37; --code-border:#3a3f49; --code-block-bg:#16191f; --code-block-border:rgba(255,255,255,0.06); --accent:#92a3b8; --accent-strong:#aebfd2; --accent-soft:rgba(146,163,184,0.18); --danger:#cf7a76; }

/* Crepe color variables */
body.light .milkdown { --crepe-color-background:var(--bg-editor); --crepe-color-on-background:var(--text); --crepe-color-surface:#fffbf7; --crepe-color-surface-low:#f5f3ef; --crepe-color-on-surface:var(--text-strong); --crepe-color-on-surface-variant:var(--muted); --crepe-color-outline:var(--border); --crepe-color-primary:var(--accent); --crepe-color-secondary:var(--accent-soft); --crepe-color-on-secondary:var(--accent-strong); --crepe-color-inverse:var(--text-strong); --crepe-color-on-inverse:var(--bg-editor); --crepe-color-inline-code:#b6587a; --crepe-color-error:var(--danger); --crepe-color-hover:var(--hover-elevated); --crepe-color-selected:var(--accent-soft); --crepe-color-inline-area:var(--code-bg); }
body.dark .milkdown { --crepe-color-background:var(--bg-editor); --crepe-color-on-background:var(--text); --crepe-color-surface:#24201c; --crepe-color-surface-low:#1e1a17; --crepe-color-on-surface:var(--text-strong); --crepe-color-on-surface-variant:var(--muted); --crepe-color-outline:var(--border); --crepe-color-primary:var(--accent); --crepe-color-secondary:var(--accent-soft); --crepe-color-on-secondary:var(--accent-strong); --crepe-color-inverse:#f0ebe6; --crepe-color-on-inverse:#16130e; --crepe-color-inline-code:#e89cb3; --crepe-color-error:var(--danger); --crepe-color-hover:var(--hover-elevated); --crepe-color-selected:var(--accent-soft); --crepe-color-inline-area:var(--code-bg); }
body.theme-morandi .milkdown, body.theme-morandi-rose .milkdown, body.theme-morandi-blue .milkdown { --crepe-color-background:var(--bg-editor); --crepe-color-on-background:var(--text); --crepe-color-surface:var(--bg-elevated); --crepe-color-surface-low:var(--hover-elevated); --crepe-color-on-surface:var(--text-strong); --crepe-color-on-surface-variant:var(--muted); --crepe-color-outline:var(--border); --crepe-color-primary:var(--accent); --crepe-color-secondary:var(--accent-soft); --crepe-color-on-secondary:var(--accent-strong); --crepe-color-inverse:var(--text-strong); --crepe-color-on-inverse:var(--bg-editor); --crepe-color-inline-code:#b6587a; --crepe-color-error:var(--danger); --crepe-color-hover:var(--hover-elevated); --crepe-color-selected:var(--accent-soft); --crepe-color-inline-area:var(--code-bg); }
body.theme-morandi-dark .milkdown { --crepe-color-background:var(--bg-editor); --crepe-color-on-background:var(--text); --crepe-color-surface:var(--bg-elevated); --crepe-color-surface-low:var(--hover-elevated); --crepe-color-on-surface:var(--text-strong); --crepe-color-on-surface-variant:var(--muted); --crepe-color-outline:var(--border); --crepe-color-primary:var(--accent); --crepe-color-secondary:var(--accent-soft); --crepe-color-on-secondary:var(--accent-strong); --crepe-color-inverse:var(--text-strong); --crepe-color-on-inverse:var(--bg-editor); --crepe-color-inline-code:#e89cb3; --crepe-color-error:var(--danger); --crepe-color-hover:var(--hover-elevated); --crepe-color-selected:var(--accent-soft); --crepe-color-inline-area:var(--code-bg); }

/* Milkdown/ProseMirror base */
.milkdown { --crepe-font-title:var(--font-write); --crepe-font-default:var(--font-write); --crepe-font-code:var(--font-mono); background:transparent !important; }
.milkdown .ProseMirror { font-size:var(--hm-font-size,16px); line-height:1.8; position:relative; user-select:text; caret-color:var(--accent); padding:0 !important; --hm-list-marker-color:color-mix(in srgb,var(--text) 72%,var(--accent) 28%); }
.milkdown .ProseMirror:focus { outline:none; }

#editor { max-width:var(--hm-content-width,820px); margin:0 auto; padding:40px clamp(24px,6vw,72px) 25vh; }
.milkdown .ProseMirror > *:first-child { margin-top:0; }
.milkdown .ProseMirror h1,.milkdown .ProseMirror h2,.milkdown .ProseMirror h3,.milkdown .ProseMirror h4,.milkdown .ProseMirror h5,.milkdown .ProseMirror h6 { font-weight:700; line-height:1.3; margin-top:1.8em; margin-bottom:0.65em; scroll-margin-top:24px; color:var(--text); }
.milkdown .ProseMirror h1 { font-size:2.25em; border-bottom:1px solid var(--border-soft); padding-bottom:0.3em; }
.milkdown .ProseMirror h2 { font-size:1.75em; }
.milkdown .ProseMirror h3 { font-size:1.4em; font-weight:600; }
.milkdown .ProseMirror h4 { font-size:1.2em; font-weight:600; }
.milkdown .ProseMirror h5,.milkdown .ProseMirror h6 { font-size:1em; font-weight:600; }
.milkdown .ProseMirror p { margin:0.8em 0; line-height:inherit; }
.milkdown .ProseMirror a { color:var(--accent); text-decoration:none; border-bottom:1px solid color-mix(in srgb,var(--accent) 28%,transparent); }
.milkdown .ProseMirror a:hover { color:var(--accent-strong); border-color:var(--accent); }
.milkdown .ProseMirror blockquote { margin:1.35em 0; padding:0.65em 1.1em; border-left:3px solid color-mix(in srgb,var(--accent) 72%,var(--border)); background:var(--code-bg); color:var(--muted); border-radius:0 var(--radius-sm) var(--radius-sm) 0; }
.milkdown .ProseMirror code { font-family:var(--font-mono); font-size:0.9em; background:var(--code-bg); border:1px solid var(--code-border); border-radius:var(--radius-sm); padding:0.12em 0.34em; }
.milkdown .ProseMirror pre { background:var(--code-block-bg); border:1px solid var(--code-block-border); border-radius:var(--radius-md); padding:1em 1.1em; overflow:auto; margin:1.2em 0; font-family:var(--font-mono); line-height:1.55; }
.milkdown .ProseMirror pre code { background:transparent; border:none; padding:0; color:#e8e3d8; }

/* Lists — Crepe renders markers in .label-wrapper, NOT through ::marker */
.milkdown .ProseMirror ul,.milkdown .ProseMirror ol { padding-left:0.25em; margin:1em 0; list-style:none; }
.milkdown .ProseMirror .milkdown-list-item-block > .list-item { display:flex; align-items:flex-start; gap:8px; }
.milkdown .ProseMirror .milkdown-list-item-block li .label-wrapper { width:20px; flex:0 0 20px; height:calc(1.8em + 8px); color:var(--hm-list-marker-color); display:flex; align-items:center; }
.milkdown .ProseMirror .milkdown-list-item-block li .label-wrapper svg { fill:currentColor; }
.milkdown .ProseMirror .milkdown-list-item-block li .label-wrapper .label { width:20px; height:100%; padding:0; display:flex; align-items:center; justify-content:flex-end; color:inherit; font-weight:500; line-height:inherit; }
.milkdown .ProseMirror .milkdown-list-item-block li .label-wrapper .label.bullet { justify-content:center; }
.milkdown .ProseMirror li { margin:0.22em 0; line-height:inherit; }
.milkdown .ProseMirror li p { margin:0; }
.milkdown .ProseMirror li::marker { color:var(--hm-list-marker-color); font-weight:500; }
.milkdown .ProseMirror ul ul,.milkdown .ProseMirror ol ol,.milkdown .ProseMirror ul ol,.milkdown .ProseMirror ol ul { margin:0.4em 0; }

/* Task lists */
.milkdown .ProseMirror .task-list-item { display:flex; align-items:flex-start; gap:10px; margin:0.6em 0; list-style:none; }
.milkdown .ProseMirror .task-list-item input { margin-top:5px; width:16px; height:16px; accent-color:var(--accent); cursor:pointer; }
.milkdown .ProseMirror .task-list-item label { cursor:pointer; flex:1; }
.milkdown .ProseMirror .task-list-item.checked label { text-decoration:line-through; color:var(--muted); }

.milkdown .katex-display { max-width:100%; overflow-x:auto; padding:4px 2px; }
.milkdown .katex { color:inherit; font-size:1.05em; }


/* CodeMirror code blocks — dark surface, readable selection */
.milkdown .ProseMirror pre code, .milkdown .ProseMirror pre, .milkdown .cm-editor, .milkdown .cm-editor .cm-content, .milkdown .cm-editor .cm-line { font-family: var(--font-mono); font-feature-settings: normal; font-variant-ligatures: none; font-variant-east-asian: normal; }
.milkdown .ProseMirror pre code::selection { background: var(--accent-soft); }
.milkdown .cm-editor .cm-selectionBackground, .milkdown .cm-editor.cm-focused .cm-selectionBackground, .milkdown .cm-editor ::selection { background: var(--accent-soft) !important; }
.milkdown .cm-editor .cm-content ::selection { color: inherit; }
.milkdown .cm-editor .cm-activeLine, .milkdown .cm-editor .cm-activeLineGutter { background: transparent; }
.milkdown .cm-editor { background: var(--code-block-bg) !important; border: 1px solid var(--code-block-border); border-radius: var(--editor-block-radius); margin: calc(var(--editor-para-spacing) * 0.6) 0; font-size: 0.92em; }
.milkdown .cm-editor .cm-scroller { padding: 14px 0; line-height: 1.6; }
.milkdown .cm-editor .cm-content { padding: 0 16px; }
.milkdown .milkdown-code-block .cm-editor .cm-gutters { background: var(--code-block-bg); border: none; color: var(--code-linenum); user-select: none; -webkit-user-select: none; margin-right: 12px; padding: 0; }
.milkdown .milkdown-code-block .cm-editor .cm-lineNumbers .cm-gutterElement { min-width: 2.4ch; padding: 0 0.95em 0 0.5em; text-align: right; font-size: 1em; font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); line-height: 1.6; color: var(--code-linenum); border-right: 1px solid var(--code-linenum-border); background: transparent; }
.milkdown .milkdown-code-block .cm-editor .cm-lineNumbers .cm-gutterElement.cm-activeLineGutter { color: var(--code-linenum-active); background: rgba(255,255,255,0.05); }

/* Inline code */
.milkdown .ProseMirror code:not(pre code) { background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--radius-sm); padding: 2px 6px; font-size: 0.88em; color: var(--accent-strong); font-family: var(--font-mono); line-height: 1.4; }

/* Tables — full styling from app.css */
.milkdown .milkdown-table-block { max-width: 100%; margin: var(--editor-block-space) 0; contain: inline-size; }
.milkdown .milkdown-table-block > div > .cell-handle[data-show='false'] { display: none; }
.milkdown .milkdown-table-block .table-wrapper { max-width: 100%; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; contain: inline-size layout paint; -webkit-overflow-scrolling: touch; }
.milkdown .ProseMirror .milkdown-table-block table.children { table-layout: auto; width: max-content; min-width: 0; }
.milkdown .ProseMirror .milkdown-table-block table.children[data-hm-column-widths='true'], .milkdown .ProseMirror .milkdown-table-block table.children[data-hm-column-preview='true'] { table-layout: fixed; }
.milkdown .ProseMirror table { border-collapse: collapse; width: 100%; margin: var(--editor-block-space) 0; overflow: hidden; border-radius: var(--editor-block-radius); border: 1px solid var(--border-soft); font-size: 0.95em; background: color-mix(in srgb, var(--editor-subtle-surface) 88%, var(--accent) 4%); }
.milkdown .ProseMirror .milkdown-table-block table { margin: 0; }
.milkdown .ProseMirror th, .milkdown .ProseMirror td { border: none; border-bottom: 1px solid var(--border-soft); padding: 0.28em 0.6em; line-height: 1.4; text-align: left; vertical-align: top; overflow-wrap: break-word; word-break: break-word; }
.milkdown .ProseMirror .milkdown-table-block th, .milkdown .ProseMirror .milkdown-table-block td { min-width: 6rem; max-width: 20rem; box-sizing: border-box; }
.milkdown .ProseMirror .milkdown-table-block th > p, .milkdown .ProseMirror .milkdown-table-block td > p { margin: 0; padding: 0; line-height: inherit; }
.milkdown .ProseMirror th { background: color-mix(in srgb, var(--editor-subtle-surface), var(--text) 9%); border-bottom: 1px solid var(--border); font-weight: 600; color: var(--text-strong); }
.milkdown .ProseMirror tr:last-child td { border-bottom: none; }
.milkdown .ProseMirror-selectednode { outline: 2px solid var(--accent-soft); outline-offset: 1px; border-radius: var(--radius-sm); }
.milkdown .milkdown-table-block.ProseMirror-selectednode, .milkdown .milkdown-table-block .ProseMirror-selectednode, .milkdown .milkdown-table-block th:has(.ProseMirror-selectednode), .milkdown .milkdown-table-block td:has(.ProseMirror-selectednode) { outline: none; }
.milkdown .milkdown-image-block.ProseMirror-selectednode, .milkdown .milkdown-image-inline.ProseMirror-selectednode, .milkdown .milkdown-image-inline.selected { outline: none !important; }
.milkdown .milkdown-image-block.selected > .image-wrapper::before { display: none !important; }
.milkdown .milkdown-table-block .line-handle { opacity: 1 !important; background: color-mix(in srgb, var(--accent) 84%, transparent); }
.milkdown .milkdown-table-block .line-handle .add-button { display: grid !important; width: 22px !important; height: 22px !important; place-items: center; padding: 0 !important; border: 1px solid var(--border); border-radius: 50% !important; background: var(--bg-elevated); box-shadow: 0 1px 3px color-mix(in srgb, var(--text) 16%, transparent); transition: transform 0.14s var(--ease-out), background 0.14s var(--ease-out), color 0.14s var(--ease-out), border-color 0.14s var(--ease-out); }
.milkdown .milkdown-table-block .line-handle .add-button:hover { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-strong); transform: translateY(-50%) translateX(-50%) scale(1.08); }
.milkdown .milkdown-table-block .line-handle[data-role='x-line-drag-handle'] .add-button:hover { transform: translateX(-50%) translateY(-50%) scale(1.08); }
.milkdown .milkdown-table-block .line-handle .add-button svg { width: 14px; height: 14px; }

/* Horizontal rule */
.milkdown .ProseMirror hr { border: none; height: 1px; background: linear-gradient(90deg, transparent, var(--border-soft), transparent); margin: 2.35em 0; }

/* Images */
.milkdown .ProseMirror img { max-width: 100%; max-height: none; height: auto; border-radius: var(--editor-block-radius); margin: var(--editor-block-space) auto; display: block; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }

/* Emphasis */
.milkdown .ProseMirror strong { font-weight: 600; color: var(--text-strong); }
.milkdown .ProseMirror em { font-style: italic; }

/* ==highlight== marks */
.milkdown .ProseMirror mark.hm-highlight, .milkdown .ProseMirror mark { color: inherit; padding: 0.05em 0.15em; border-radius: 2px; -webkit-text-decoration-line: none; text-decoration-line: none; }
.milkdown .ProseMirror mark.hm-hl-yellow { background: #fff3a3; }
.milkdown .ProseMirror mark.hm-hl-red { background: #ffc6c6; }
.milkdown .ProseMirror mark.hm-hl-blue { background: #bcd9ff; }
body.dark .milkdown .ProseMirror mark.hm-hl-yellow { background: #7a6c12; }
body.dark .milkdown .ProseMirror mark.hm-hl-red { background: #7a3434; }
body.dark .milkdown .ProseMirror mark.hm-hl-blue { background: #2f4a6b; }

/* Frontmatter card */
.hm-frontmatter-wrap { margin: 0 0 1.25em; }
.hm-frontmatter { border: 1px solid var(--border-soft); border-radius: 6px; background: var(--bg-elevated); overflow: hidden; font-size: 0.9em; }
.hm-frontmatter-head { display: flex; align-items: center; justify-content: space-between; min-height: 30px; padding: 0 10px 0 13px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent-strong); background: color-mix(in srgb, var(--accent-soft) 72%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--border-soft) 72%, transparent); }
.hm-frontmatter-title { line-height: 1; }
.hm-frontmatter-action { min-height: 22px; padding: 2px 7px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); font: inherit; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: none; cursor: pointer; }
.hm-frontmatter-action:hover, .hm-frontmatter-action:focus-visible { color: var(--accent-strong); background: var(--hover); outline: none; }
.hm-frontmatter-grid { display: grid; grid-template-columns: max-content 1fr; gap: 0; margin: 0; padding: 8px 14px; }
.hm-frontmatter-grid dt { grid-column: 1; color: var(--muted); font-weight: 500; padding: 3px 16px 3px 0; white-space: nowrap; }
.hm-frontmatter-grid dd { grid-column: 2; margin: 0; padding: 3px 0; color: var(--text); word-break: break-word; }
.hm-frontmatter-raw { margin: 0; padding: 10px 14px; font-family: var(--font-mono); font-size: 12.5px; color: var(--text); white-space: pre-wrap; word-break: break-word; }
.hm-frontmatter-input { display: block; box-sizing: border-box; width: 100%; min-height: 88px; margin: 0; padding: 10px 13px; border: 0; border-radius: 0; outline: 0; resize: vertical; background: transparent; color: var(--text); font-family: var(--font-mono); font-size: 12.5px; line-height: 1.55; }
.hm-frontmatter-input:focus { background: color-mix(in srgb, var(--accent-soft) 18%, transparent); box-shadow: inset 2px 0 0 var(--accent); }

/* HTML blocks */
.hm-html-block { margin: 0.6em 0; max-width: 100%; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; contain: inline-size layout paint; -webkit-overflow-scrolling: touch; white-space: normal; }
.hm-html-block pre { white-space: pre; }
.milkdown .ProseMirror .hm-html-block table { border-collapse: collapse; table-layout: auto; width: max-content; min-width: 100%; max-width: 100%; }
.milkdown .ProseMirror .hm-html-block table[width] { width: unset; }
.milkdown .ProseMirror .hm-html-block th, .milkdown .ProseMirror .hm-html-block td { min-width: 0; max-width: 24rem; border: 1px solid var(--border); padding: 6px 12px; text-align: left; vertical-align: top; white-space: normal; overflow-wrap: break-word; word-break: break-word; }
.hm-html-block th { background: var(--hover-elevated, var(--border-soft)); font-weight: 700; }
.hm-html-block img { max-width: 100%; }
.hm-html-table-block table img { width: 100%; height: auto; }
.hm-html-inline { display: inline; }

/* Math preview tooltip */
.hm-math-preview { position: fixed; z-index: 60; pointer-events: none; max-width: 420px; padding: 6px 10px; background: var(--bg-elevated); border: 1px solid var(--border-soft); border-radius: var(--radius-md); box-shadow: var(--shadow-float); color: var(--text); font-size: 0.95em; line-height: 1.4; }
.hm-math-preview .katex { color: inherit; font-size: 1.05em; }
.milkdown .milkdown-latex-inline-edit .hm-inline-math-clear { margin-left: 6px; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; line-height: 1; padding: 5px 8px; }
/* Outline sidebar */
#hm-outline { width:240px; flex-shrink:0; overflow-y:auto; border-right:1px solid var(--border-soft); background:var(--bg-sidebar,var(--bg)); padding:16px 8px 16px 12px; }
#hm-outline nav { display:flex; flex-direction:column; gap:1px; }
.hm-outline-item { display:block; padding:3px 8px; font-size:13px; color:var(--muted); text-decoration:none; cursor:pointer; border:none!important; border-radius:var(--radius-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hm-outline-item:hover { background:var(--hover-elevated,var(--code-bg)); color:var(--text); }
.hm-outline-item.hm-active { color:var(--accent); font-weight:500; }
.hm-outline-l1 { font-weight:600; font-size:14px; color:var(--text); }
.hm-outline-l2 { padding-left:20px; }
.hm-outline-l3 { padding-left:36px; font-size:12px; }
.hm-outline-l4,.hm-outline-l5,.hm-outline-l6 { padding-left:52px; font-size:12px; opacity:0.8; }
.hm-outline-empty { color:var(--faint,var(--muted)); font-size:12px; padding:8px; }
#hm-scroll::-webkit-scrollbar { width:10px; }
#hm-scroll::-webkit-scrollbar-track { background:transparent; }
#hm-scroll::-webkit-scrollbar-thumb { background:var(--border); border-radius:5px; }
`
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length))
  return s
}

function deactivate() {
  docStates.clear()
}

module.exports = { activate, deactivate }
