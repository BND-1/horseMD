// HorseMD VSCode extension — WYSIWYG editor via Custom Editor API.
// Opening a .md file directly opens the Milkdown Crepe editor (no command needed).
// Edits sync to the TextDocument; VSCode handles save/dirty state.

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')

// Per-document state, keyed by uri.toString()
const docStates = new Map()

class HorsemdEditorProvider {
  openCustomDocument(uri) {
    return { uri, dispose() {} }
  }

  async resolveCustomEditor(document, panel, token) {
    const key = document.uri.toString()

    // Webview options — per-document localResourceRoots for images
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: getLocalResourceRoots(document.uri)
    }

    const cfg = vscode.workspace.getConfiguration('horsemdPreview')

    // Read initial content from the TextDocument
    let initialContent = ''
    try {
      const doc = await vscode.workspace.openTextDocument(document.uri)
      initialContent = doc.getText()
    } catch {
      try { initialContent = fs.readFileSync(document.uri.fsPath, 'utf8') } catch {}
    }

    panel.webview.html = getHtml(panel.webview, {
      theme: cfg.get('theme') || 'auto',
      fontSize: cfg.get('fontSize') || 16,
      contentWidth: cfg.get('contentWidth') || 'standard',
      showOutline: cfg.get('showOutline') !== false,
      content: initialContent
    })

    const state = {
      isWebviewEditing: false,
      pendingEdit: null,
      disposed: false,
      debounceTimer: null
    }
    docStates.set(key, { panel, state })

    // ===== Webview → Document =====
    const msgDisposable = panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        // Content was passed inline in HTML; nothing to do
      } else if (msg.type === 'edit') {
        if (state.disposed) return
        if (state.isWebviewEditing) { state.pendingEdit = msg.markdown; return }
        state.isWebviewEditing = true
        try {
          await updateDocument(document.uri, msg.markdown)
          // Process queued edits
          while (state.pendingEdit && !state.disposed) {
            const pending = state.pendingEdit
            state.pendingEdit = null
            await updateDocument(document.uri, pending)
          }
          // Auto-save if configured
          if (cfg.get('autoSave') !== false) {
            try {
              const doc = await vscode.workspace.openTextDocument(document.uri)
              await doc.save()
            } catch {}
          }
        } catch {}
        setTimeout(() => { state.isWebviewEditing = false }, 200)
      } else if (msg.type === 'switchTheme') {
        await vscode.workspace.getConfiguration('horsemdPreview').update('theme', msg.theme, vscode.ConfigurationTarget.Global)
        for (const { panel: p } of docStates.values()) p.webview.postMessage({ type: 'theme', theme: msg.theme })
      } else if (msg.type === 'toggleOutline') {
        for (const { panel: p } of docStates.values()) p.webview.postMessage({ type: 'toggleOutline' })
      }
    })

    // ===== Document → Webview (external edits, text editor, undo/redo) =====
    const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== key) return
      if (state.isWebviewEditing || state.disposed) return
      clearTimeout(state.debounceTimer)
      state.debounceTimer = setTimeout(() => {
        if (state.disposed) return
        try {
          const content = e.document.getText()
          panel.webview.postMessage({ type: 'update', content })
        } catch {}
      }, 150)
    })

    // VSCode color theme change
    const themeDisposable = vscode.window.onDidChangeActiveColorTheme(() => {
      if (!state.disposed) panel.webview.postMessage({ type: 'colorThemeChanged' })
    })

    panel.onDidDispose(() => {
      state.disposed = true
      clearTimeout(state.debounceTimer)
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
    await vscode.workspace.getConfiguration('horsemdPreview').update('theme', pick.id, vscode.ConfigurationTarget.Global)
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

function getHtml(webview, opts) {
  const csp = webview.cspSource
  const nonce = getNonce()
  const cdn = 'https://cdn.jsdelivr.net'
  const crepeVarsCss = cdn + '/npm/@milkdown/crepe@7/style/vars.css'
  const crepeCss = cdn + '/npm/@milkdown/crepe@7/style/all.css'
  const katexCss = cdn + '/npm/katex@0.16.11/dist/katex.min.css'
  const crepeEsm = cdn + '/npm/@milkdown/crepe@7/+esm'

  // Escape content for safe embedding in a JS template literal
  const contentEsc = String(opts.content || '')
    .replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: ${csp} blob:; style-src 'unsafe-inline' ${csp} ${cdn}; script-src 'unsafe-inline' 'unsafe-eval' ${cdn}; font-src data: ${csp} ${cdn}; worker-src 'none';">
  <link rel="stylesheet" href="${crepeVarsCss}">
  <link rel="stylesheet" href="${crepeCss}">
  <link rel="stylesheet" href="${katexCss}">
  <style>${getThemeCSS()}</style>
</head>
<body data-vscode-theme-kind="" class="light">
  <div id="hm-app">
    <aside id="hm-outline" class="hm-outline${opts.showOutline ? '' : ' hm-hidden'}"></aside>
    <main id="hm-scroll" class="hm-scroll">
      <div id="editor"></div>
    </main>
  </div>
  <script nonce="${nonce}">
    window.__vscode = acquireVsCodeApi();
    window.__horsemd = ${JSON.stringify({ theme: opts.theme, fontSize: opts.fontSize, contentWidth: opts.contentWidth, showOutline: opts.showOutline })};
    window.__horsemd_content = \`${contentEsc}\`;
  </script>
  <script nonce="${nonce}" type="module">
    import { Crepe, CrepeFeature } from '${crepeEsm}';

    const vscode = window.__vscode;
    const opts = window.__horsemd;
    let crepe = null;
    let suppressUpdate = false;
    let lastMd = '';

    // ===== Theme =====
    const THEME_CLASSES = ['light', 'dark', 'theme-morandi', 'theme-morandi-rose', 'theme-morandi-blue', 'theme-morandi-dark'];
    const THEMES = [
      { id: 'light', base: 'light', cls: '' },
      { id: 'dark', base: 'dark', cls: '' },
      { id: 'morandi', base: 'light', cls: 'theme-morandi' },
      { id: 'morandi-rose', base: 'light', cls: 'theme-morandi-rose' },
      { id: 'morandi-blue', base: 'light', cls: 'theme-morandi-blue' },
      { id: 'morandi-dark', base: 'dark', cls: 'theme-morandi-dark' }
    ];

    function applyTheme(themeId) {
      document.body.classList.remove(...THEME_CLASSES);
      let resolved = themeId;
      if (themeId === 'auto') {
        const kind = document.body.getAttribute('data-vscode-theme-kind') || '';
        resolved = kind.includes('dark') || kind.includes('high-contrast') ? 'dark' : 'light';
      }
      const theme = THEMES.find(t => t.id === resolved) || THEMES[0];
      document.body.classList.add(theme.base);
      if (theme.cls) document.body.classList.add(theme.cls);
    }

    let currentTheme = opts.theme || 'auto';
    applyTheme(currentTheme);

    if (opts.fontSize) document.documentElement.style.setProperty('--hm-font-size', opts.fontSize + 'px');
    if (opts.contentWidth) {
      const widths = { compact: '680px', standard: '820px', wide: '1040px', full: 'none' };
      document.documentElement.style.setProperty('--hm-content-width', widths[opts.contentWidth] || '820px');
    }

    new MutationObserver(() => {
      if (currentTheme === 'auto') applyTheme('auto');
    }).observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-kind'] });

    // ===== Outline =====
    let scrollSpyRaf = 0;
    let scrollSpyCleanup = null;

    function generateOutline() {
      const headings = document.querySelectorAll('#editor h1, #editor h2, #editor h3, #editor h4, #editor h5, #editor h6');
      const nav = document.getElementById('hm-outline');
      if (!nav) return;
      if (!headings.length) { nav.innerHTML = '<p class="hm-outline-empty">No headings</p>'; return; }
      const items = [];
      headings.forEach((h, i) => {
        if (!h.id) h.id = 'hm-heading-' + (i + 1);
        items.push({ id: h.id, level: parseInt(h.tagName[1]), text: h.textContent.trim() });
      });
      nav.innerHTML = '<nav>' + items.map(item =>
        '<a href="#' + item.id + '" class="hm-outline-item hm-outline-l' + item.level + '" data-target="' + item.id + '">' +
        item.text.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])) + '</a>'
      ).join('') + '</nav>';
      nav.querySelectorAll('a').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          const el = document.getElementById(a.dataset.target);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
      setupScrollSpy(headings);
    }

    function setupScrollSpy(headings) {
      if (scrollSpyCleanup) scrollSpyCleanup();
      const scroll = document.getElementById('hm-scroll');
      const links = document.querySelectorAll('.hm-outline-item');
      function onScroll() {
        cancelAnimationFrame(scrollSpyRaf);
        scrollSpyRaf = requestAnimationFrame(() => {
          let activeIdx = 0;
          const scrollTop = scroll.scrollTop;
          for (let i = 0; i < headings.length; i++) {
            if (headings[i].offsetTop - 80 <= scrollTop) activeIdx = i;
          }
          links.forEach((l, i) => l.classList.toggle('hm-active', i === activeIdx));
        });
      }
      scroll.addEventListener('scroll', onScroll, { passive: true });
      scrollSpyCleanup = () => scroll.removeEventListener('scroll', onScroll);
      onScroll();
    }

    // ===== Init Crepe =====
    try {
      crepe = new Crepe({
        root: '#editor',
        defaultValue: window.__horsemd_content || '',
        features: {
          [CrepeFeature.SelectionTooltip]: true,
          [CrepeFeature.SlashCommand]: true,
          [CrepeFeature.BlockEdit]: true,
          [CrepeFeature.CodeMirror]: true,
          [CrepeFeature.Table]: true,
          [CrepeFeature.InlineCode]: true,
          [CrepeFeature.LinkTooltip]: true,
          [CrepeFeature.Latex]: true,
          [CrepeFeature.Cursor]: false,
        }
      });

      await crepe.create();
      lastMd = window.__horsemd_content || '';
      generateOutline();

      // Poll for content changes → send to host
      setInterval(async () => {
        if (suppressUpdate) return;
        try {
          const md = await crepe.getMarkdown();
          if (md !== lastMd) {
            lastMd = md;
            vscode.postMessage({ type: 'edit', markdown: md });
            generateOutline();
          }
        } catch {}
      }, 300);

      vscode.postMessage({ type: 'ready' });
    } catch (err) {
      document.getElementById('editor').innerHTML =
        '<pre style="padding:2em;color:#c93b3b;font-family:monospace;white-space:pre-wrap">Failed to load Milkdown Crepe:\\n' +
        (err.message || err) + '\\n\\nCheck network connection to ${cdn}</pre>';
    }

    // ===== Messages from host =====
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'update' && crepe) {
        if (msg.content !== lastMd) {
          suppressUpdate = true;
          try { crepe.setMarkdown(msg.content); } catch {}
          lastMd = msg.content;
          generateOutline();
          setTimeout(() => { suppressUpdate = false; }, 200);
        }
      } else if (msg.type === 'theme') {
        currentTheme = msg.theme;
        applyTheme(msg.theme);
      } else if (msg.type === 'colorThemeChanged') {
        if (currentTheme === 'auto') applyTheme('auto');
      } else if (msg.type === 'toggleOutline') {
        document.getElementById('hm-outline').classList.toggle('hm-hidden');
      }
    });
  </script>
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
  --radius-sm: 5px; --radius-md: 8px;
}

/* Theme palettes (from HorseMD app.css) */
body.light { --bg:#ebe7e0; --bg-elevated:#faf8f5; --bg-sidebar:#e3dfd7; --bg-editor:#fdfbf7; --text:#2a2620; --text-strong:#0f0d0a; --muted:#5a5650; --faint:#8a867e; --border:#c8c4bc; --border-soft:#ddd9d2; --hover-elevated:#f0ede5; --code-bg:#f2efe8; --code-border:#ddd9d2; --code-block-bg:#2a2730; --code-block-border:rgba(0,0,0,0.25); --accent:#c86b35; --accent-strong:#a04f22; --accent-soft:rgba(200,107,53,0.15); --danger:#c93b3b; }
body.dark { --bg:#16130e; --bg-elevated:#1e1a16; --bg-sidebar:#191512; --bg-editor:#1d1914; --text:#d0c8bc; --text-strong:#f2ebe0; --muted:#8a8378; --faint:#6a655c; --border:#3a3630; --border-soft:#302c28; --hover-elevated:#2e2a24; --code-bg:#24201c; --code-border:#3a3630; --code-block-bg:#100e0b; --code-block-border:rgba(255,255,255,0.06); --accent:#e69055; --accent-strong:#ffb080; --accent-soft:rgba(230,144,85,0.18); --danger:#ff7070; }
body.theme-morandi { --bg:#e7e8e2; --bg-elevated:#f3f4ef; --bg-sidebar:#dfe1d9; --bg-editor:#f6f7f2; --text:#3a3d35; --text-strong:#23261f; --muted:#6c6f63; --faint:#97998d; --border:#c5c8bc; --border-soft:#d9dbd0; --hover-elevated:#ecede6; --code-bg:#eceee6; --code-border:#d9dbd0; --code-block-bg:#2a2730; --code-block-border:rgba(0,0,0,0.25); --accent:#7d8a6a; --accent-strong:#5f6b4e; --accent-soft:rgba(125,138,106,0.16); --danger:#b3645f; }
body.theme-morandi-rose { --bg:#ece5e2; --bg-elevated:#f6f1ef; --bg-sidebar:#e5ddd9; --bg-editor:#f8f4f2; --text:#423a37; --text-strong:#271f1c; --muted:#70645f; --faint:#9c918b; --border:#ccc1bc; --border-soft:#ddd4cf; --hover-elevated:#efe8e5; --code-bg:#efe8e5; --code-border:#ddd4cf; --code-block-bg:#2a2730; --code-block-border:rgba(0,0,0,0.25); --accent:#a8807b; --accent-strong:#855e59; --accent-soft:rgba(168,128,123,0.18); --danger:#b85c57; }
body.theme-morandi-blue { --bg:#e4e7ea; --bg-elevated:#f1f3f5; --bg-sidebar:#dce0e4; --bg-editor:#f5f7f8; --text:#383d42; --text-strong:#1f242a; --muted:#656d74; --faint:#939ba2; --border:#c2c8ce; --border-soft:#d6dade; --hover-elevated:#eaedf0; --code-bg:#e9edf0; --code-border:#d6dade; --code-block-bg:#2a2730; --code-block-border:rgba(0,0,0,0.25); --accent:#7e94a6; --accent-strong:#5d7385; --accent-soft:rgba(126,148,166,0.18); --danger:#b3645f; }
body.theme-morandi-dark { --bg:#21242b; --bg-elevated:#282c34; --bg-sidebar:#23262d; --bg-editor:#262a31; --text:#c3c7cd; --text-strong:#e7eaef; --muted:#878c95; --faint:#5f636b; --border:#3a3f49; --border-soft:#313640; --hover-elevated:#2e333c; --code-bg:#2b2f37; --code-border:#3a3f49; --code-block-bg:#16191f; --code-block-border:rgba(255,255,255,0.06); --accent:#92a3b8; --accent-strong:#aebfd2; --accent-soft:rgba(146,163,184,0.18); --danger:#cf7a76; }

/* Crepe color variables (from app.css lines 5752-5789) */
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
.milkdown .ProseMirror table { border-collapse:collapse; width:100%; margin:1.35em 0; }
.milkdown .ProseMirror th,.milkdown .ProseMirror td { border:none; border-bottom:1px solid var(--border-soft); padding:0.5em 0.75em; text-align:left; }
.milkdown .ProseMirror th { background:var(--code-bg); font-weight:600; }
.milkdown .ProseMirror tr:last-child td { border-bottom:none; }

/* Lists — Crepe renders markers in .label-wrapper, NOT through ::marker.
   Without display:flex on .list-item, label and text stack vertically (marker above text). */
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

.milkdown .ProseMirror hr { border:0; border-top:1px solid var(--border-soft); margin:2.2em 0; }
.milkdown .ProseMirror img { max-width:100%; height:auto; border-radius:var(--radius-md); margin:1.4em auto; display:block; }
.milkdown .katex-display { max-width:100%; overflow-x:auto; padding:4px 2px; }
.milkdown .katex { color:inherit; font-size:1.05em; }

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
