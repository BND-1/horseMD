// Default Markdown editor (#170): pure helpers (no Electron), tested by
// scripts/test-default-app.mjs. The OS calls live in default-app.js.
//
// Every platform lets the user confirm the change, as browsers and editors
// do: macOS 12+ shows its own "use HorseMD for .md?" dialog
// (NSWorkspace setDefaultApplicationAtURL), Windows 10/11 allow it only
// through the user's choice in the "Open with" dialog, Linux (xdg-mime)
// has no prompt — the click on the button is the consent.

import { basename } from 'node:path'

export const MARKDOWN_EXTS = ['md', 'markdown']
export const LINUX_MIME_TYPES = ['text/markdown', 'text/x-markdown']

// ---- Windows ---------------------------------------------------------------

// PowerShell (UTF-8 JSON out): the ProgId that opens each extension (the
// user's choice — 24H2 writes UserChoiceLatest — else the class default)
// and that ProgId's open command.
export const WINDOWS_QUERY_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = @{}
foreach ($e in '.md', '.markdown') {
  $p = $null
  $base = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\$e"
  foreach ($k in "$base\\UserChoiceLatest\\ProgId", "$base\\UserChoiceLatest", "$base\\UserChoice") {
    $v = (Get-ItemProperty -LiteralPath $k).ProgId
    if ($v) { $p = $v; break }
  }
  $source = if ($p) { 'user' } else { 'class' }
  if (-not $p) { $p = (Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\\$e").'(default)' }
  $cmd = $null
  if ($p) { $cmd = (Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\\$p\\shell\\open\\command").'(default)' }
  $out[$e] = @{ progId = $p; command = $cmd; source = $source }
}
$out | ConvertTo-Json -Compress
`

// The executable a shell open command runs: `"C:\a b\x.exe" "%1"` or
// `C:\x.exe %1`. '' when there is none.
export function windowsCommandExe(command) {
  const text = String(command || '').trim()
  if (!text) return ''
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1)
    return end > 1 ? text.slice(1, end) : ''
  }
  const exe = text.match(/^(.+?\.exe)\b/i)
  return exe ? exe[1] : text.split(/\s+/)[0]
}

const sameWindowsPath = (a, b) => Boolean(a && b) && a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

// A readable name for the app: the executable without .exe ("Typora",
// "Code", "notepad"), or the ProgId's last part for store apps.
export function windowsAppName(entry) {
  const exe = windowsCommandExe(entry?.command)
  if (exe) return basename(exe.replace(/\\/g, '/')).replace(/\.exe$/i, '')
  const progId = String(entry?.progId || '')
  if (!progId) return ''
  return progId.replace(/^Applications\\/i, '').replace(/\.exe$/i, '')
}

// { isDefault, current } from the query JSON for this executable. Only .md
// decides (.markdown follows it in practice and has its own entry in the
// same dialog).
export function windowsDefaultState(json, execPath) {
  let data = null
  try { data = typeof json === 'string' ? JSON.parse(json) : json } catch { data = null }
  const md = data?.['.md'] || null
  if (!md) return { isDefault: false, current: '' }
  const isDefault = sameWindowsPath(windowsCommandExe(md.command), execPath)
  return { isDefault, current: isDefault ? '' : windowsAppName(md) }
}

// ---- Linux -----------------------------------------------------------------

// The parts of a .desktop file we need (the [Desktop Entry] group only).
export function parseDesktopEntry(text) {
  const entry = {}
  let inEntry = false
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]'
      continue
    }
    if (!inEntry) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    if (key === 'Name' || key === 'Exec' || key === 'MimeType' || key === 'Type' || key === 'NoDisplay') entry[key] = line.slice(eq + 1).trim()
  }
  return entry
}

// The program an Exec line starts: `/opt/HorseMD/horse %U`, `"/opt/a b/x" %f`,
// `env FOO=1 horse %U`.
export function desktopExecProgram(exec) {
  const tokens = String(exec || '').match(/"[^"]*"|\S+/g) || []
  let i = 0
  if (tokens[i] === 'env') {
    i++
    while (tokens[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  }
  return (tokens[i] || '').replace(/^"|"$/g, '')
}

// Our desktop file among candidates [{ id, text, programPath }], where
// programPath is the resolved Exec program (default-app.js resolves PATH and
// symlinks). Prefers one that lists text/markdown.
export function pickLinuxDesktopFile(candidates, execPath) {
  const ours = candidates.filter((c) => c.programPath && c.programPath === execPath)
  if (!ours.length) return null
  const withMime = ours.find((c) => /(^|;)text\/(x-)?markdown(;|$)/.test(parseDesktopEntry(c.text).MimeType || ''))
  return (withMime || ours[0]).id
}

// ---- macOS -----------------------------------------------------------------

// JXA run by osascript. argv: [mode ('get' | 'set'), app bundle path].
// Prints JSON { ok, isDefault, current, bundleId, waited }. 'set' asks the
// system to make the bundle the default for every content type of .md and
// .markdown; macOS 12+ shows its own confirmation dialog and calls back
// with the user's answer (we wait up to 3 minutes). macOS 11 has only the
// LaunchServices call (no dialog).
export const MAC_DEFAULT_APP_SCRIPT = `
function run(argv) {
  ObjC.import('AppKit')
  ObjC.import('CoreServices')
  ObjC.import('Foundation')
  const mode = argv[0]
  const bundlePath = argv[1]
  const ws = $.NSWorkspace.sharedWorkspace
  const UTType = $.NSClassFromString('UTType')
  const modern = UTType && !UTType.isNil() && ws.respondsToSelector('setDefaultApplicationAtURL:toOpenContentType:completionHandler:')
  const ownBundle = $.NSBundle.bundleWithPath($(bundlePath))
  const ownId = ownBundle && !ownBundle.isNil() ? ObjC.unwrap(ownBundle.bundleIdentifier) : ''
  const exts = ['md', 'markdown']
  const types = []
  const seen = {}
  for (const ext of exts) {
    let id = ''
    let type = null
    if (modern) {
      type = UTType.typeWithFilenameExtension($(ext))
      if (type && !type.isNil()) id = ObjC.unwrap(type.identifier)
    } else {
      const ref = $.UTTypeCreatePreferredIdentifierForTag($.kUTTagClassFilenameExtension, $(ext), null)
      id = ref ? ObjC.unwrap(ObjC.castRefToObject(ref)) : ''
    }
    if (id && !seen[id]) { seen[id] = true; types.push({ id, type }) }
  }
  const handlerOf = (t) => {
    if (modern) {
      const url = ws.URLForApplicationToOpenContentType(t.type)
      if (!url || url.isNil()) return { id: '', name: '' }
      const bundle = $.NSBundle.bundleWithURL(url)
      const id = bundle && !bundle.isNil() ? ObjC.unwrap(bundle.bundleIdentifier) : ''
      return { id, name: ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(url.path)).replace(/\\.app$/, '') }
    }
    const ref = $.LSCopyDefaultRoleHandlerForContentType($(t.id), $.kLSRolesAll)
    const id = ref ? ObjC.unwrap(ObjC.castRefToObject(ref)) : ''
    const url = id ? ws.URLForApplicationWithBundleIdentifier($(id)) : null
    const name = url && !url.isNil() ? ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(url.path)).replace(/\\.app$/, '') : id
    return { id, name }
  }
  const state = () => {
    const first = types.length ? handlerOf(types[0]) : { id: '', name: '' }
    const all = types.every((t) => handlerOf(t).id === ownId)
    return { isDefault: Boolean(ownId) && types.length > 0 && all, current: first.id === ownId ? '' : first.name }
  }
  let waited = false
  if (mode === 'set' && ownId) {
    if (modern) {
      const appUrl = $.NSURL.fileURLWithPath($(bundlePath))
      let pending = 0
      for (const t of types) {
        if (handlerOf(t).id === ownId) continue
        pending++
        ws.setDefaultApplicationAtURLToOpenContentTypeCompletionHandler(appUrl, t.type, () => { pending-- })
      }
      const loop = $.NSRunLoop.currentRunLoop
      const until = Date.now() + 180000
      while (pending > 0 && Date.now() < until) loop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2))
      waited = true
    } else {
      for (const t of types) $.LSSetDefaultRoleHandlerForContentType($(t.id), $.kLSRolesAll, $(ownId))
    }
  }
  return JSON.stringify(Object.assign({ ok: true, bundleId: ownId, waited }, state()))
}
`
