// Build-time fixes to Milkdown library code that our own code cannot reach
// (closures inside compiled node views). Each fix names the exact source it
// replaces; when Milkdown changes it the build FAILS, so an upgrade has to
// look at the fix again instead of silently losing it.
//
// Used by electron.vite.config.mjs and vite.mobile.config.mjs, for the
// production build (Rollup `transform`) and for dev (the esbuild pre-bundle).

const FIXES = [
  {
    // Crepe's list item node view restores the selection it saw at mount one
    // animation frame later (moving contentDOM into the Vue tree loses the DOM
    // selection). It checks only that the document did not change: a click or
    // arrow key inside that frame was undone — the caret jumped back. A
    // window whose frames are delayed (in the background, just opened)
    // made that a window of seconds: Windows test PC 2026-11-06, a click into
    // a list item right after opening landed at the document start, and the
    // DOM caret of a converted list stayed in the wrong item until a frame
    // came. Restore right after the update that mounted the item (a
    // microtask: the node view is in the document by then), and only while
    // the selection is still the one seen at mount.
    //
    // Vue calls the content wrapper's ref on EVERY re-render (a checkbox
    // toggle, a label change), and appendChild of the already placed
    // contentDOM took it out and put it back: the DOM caret inside was lost
    // and ProseMirror's mutation observer read the lost caret (a microtask,
    // before our restore) — after ticking a task the caret sat in the heading
    // above. Nothing moves when contentDOM is already in place, so nothing is
    // lost.
    file: /[\\/]@milkdown[\\/]components[\\/]lib[\\/]list-item-block[\\/]index\.js$/,
    find: `      const onMount = (div) => {
        const { anchor, head } = view.state.selection;
        div.appendChild(contentDOM);
        const anchorPos = view.state.doc.resolve(anchor);
        const headPos = view.state.doc.resolve(head);
        raf = requestAnimationFrame(() => {
          cancelAnimationFrame(raf);
          if (!anchorPos.doc.eq(view.state.doc)) return;`,
    replace: `      const onMount = (div) => {
        if (contentDOM.parentNode === div) return;
        const mountedSelection = view.state.selection;
        const { anchor, head } = mountedSelection;
        div.appendChild(contentDOM);
        const anchorPos = view.state.doc.resolve(anchor);
        const headPos = view.state.doc.resolve(head);
        queueMicrotask(() => {
          if (!dom.isConnected) return;
          if (!anchorPos.doc.eq(view.state.doc)) return;
          if (view.state.selection !== mountedSelection && !view.state.selection.eq(mountedSelection)) return;`
  }
]

const apply = (id, code) => {
  let out = code
  for (const fix of FIXES) {
    if (!fix.file.test(id)) continue
    // Milkdown ships LF; normalize in case a checkout converted it.
    out = out.replace(/\r\n/g, '\n')
    if (!out.includes(fix.find)) {
      throw new Error(`milkdown-fixes: the code to patch in ${id} changed (Milkdown upgraded?). Review the fix in vite.milkdown-fixes.mjs.`)
    }
    out = out.replace(fix.find, fix.replace)
  }
  return out
}

export function milkdownFixes() {
  const applied = new Set()
  return {
    name: 'horsemd-milkdown-fixes',
    enforce: 'pre',
    transform(code, id) {
      const path = id.split('?')[0]
      const matching = FIXES.filter((fix) => fix.file.test(path))
      if (!matching.length) return null
      matching.forEach((fix) => applied.add(fix))
      return { code: apply(path, code), map: null }
    },
    // A fix whose file was never bundled (moved / renamed by an upgrade) is
    // lost just as silently as one whose code changed.
    buildEnd(error) {
      if (error || this.meta?.watchMode) return
      const missing = FIXES.filter((fix) => !applied.has(fix))
      if (missing.length) this.error(`milkdown-fixes: no bundled file matched ${missing.map((fix) => fix.file).join(', ')} — review vite.milkdown-fixes.mjs.`)
    },
    config() {
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [{
              name: 'horsemd-milkdown-fixes',
              setup(build) {
                build.onLoad({ filter: /list-item-block[\\/]index\.js$/ }, async (args) => {
                  if (!FIXES.some((fix) => fix.file.test(args.path))) return undefined
                  const { readFile } = await import('node:fs/promises')
                  return { contents: apply(args.path, await readFile(args.path, 'utf8')), loader: 'js' }
                })
              }
            }]
          }
        }
      }
    }
  }
}
