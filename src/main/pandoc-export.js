import { app, dialog, shell } from 'electron'
import fs from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { buildPandocArgs, gfmSupportsMathDollars, PANDOC_FORMATS, parsePandocVersion, summarizePandocStderr } from './pandoc-core.js'
import { runSubprocess } from './subprocess.js'
import { getSaveDirFor, recordSaveDir } from './export-prefs.js'
import { applyPandocFigures } from './pandoc-figures.js'

// Formats whose output carries images (Typora puts rendered diagrams into
// docx / epub too). MediaWiki and plain text keep the source.
const FIGURE_FORMATS = new Set(['docx', 'odt', 'epub', 'rtf', 'latex'])

const MAX_MARKDOWN_BYTES = 50 * 1024 * 1024
const CONFIG_FILE = 'document-tools.json'

const executableName = (path) => /^pandoc(?:\.exe)?$/i.test(basename(String(path || '')))

const candidatePaths = (configuredPath = '') => {
  const names = process.platform === 'win32' ? ['pandoc.exe', 'pandoc'] : ['pandoc']
  const fromPath = String(process.env.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((dir) => names.map((name) => join(dir, name)))
  const common = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/pandoc', '/usr/local/bin/pandoc', '/usr/bin/pandoc']
    : process.platform === 'win32'
      ? [
          join(process.env.LOCALAPPDATA || '', 'Pandoc', 'pandoc.exe'),
          join(process.env.PROGRAMFILES || '', 'Pandoc', 'pandoc.exe')
        ]
      : ['/usr/local/bin/pandoc', '/usr/bin/pandoc', '/snap/bin/pandoc']
  return [...new Set([configuredPath, ...fromPath, ...common].filter(Boolean))]
}

const probePandoc = async (path) => {
  if (!executableName(path) || !isAbsolute(path)) return null
  try {
    const info = await fs.stat(path)
    if (!info.isFile()) return null
    const result = await runSubprocess({ executable: path, args: ['--version'], timeoutMs: 5000 })
    if (result.timedOut || result.code !== 0) return null
    const version = parsePandocVersion(result.stdout)
    if (!version) return null
    let mathDollars = false
    try {
      const listed = await runSubprocess({ executable: path, args: ['--list-extensions=gfm'], timeoutMs: 5000 })
      mathDollars = !listed.timedOut && listed.code === 0 && gfmSupportsMathDollars(listed.stdout)
    } catch {
      mathDollars = false
    }
    return { available: true, path, version, mathDollars }
  } catch {
    return null
  }
}

export function createPandocExportService({ getMainWindow, getUserDataPath = () => app.getPath('userData') }) {
  let configuredPath = ''
  let configLoaded = false

  const configPath = () => join(getUserDataPath(), CONFIG_FILE)
  const loadConfig = async () => {
    if (configLoaded) return
    configLoaded = true
    try {
      const parsed = JSON.parse(await fs.readFile(configPath(), 'utf8'))
      configuredPath = typeof parsed.pandocPath === 'string' ? parsed.pandocPath : ''
    } catch {
      configuredPath = ''
    }
  }
  const saveConfig = async () => {
    const target = configPath()
    const temp = `${target}.tmp`
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(temp, JSON.stringify({ version: 1, pandocPath: configuredPath }, null, 2), 'utf8')
    await fs.rename(temp, target)
  }

  const detect = async () => {
    await loadConfig()
    for (const path of candidatePaths(configuredPath)) {
      const result = await probePandoc(path)
      if (result) return { ...result, custom: path === configuredPath && !!configuredPath }
    }
    return { available: false, path: null, version: null, custom: false }
  }

  const chooseExecutable = async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Select Pandoc executable',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Pandoc', extensions: ['exe'] }]
        : [{ name: 'All Files', extensions: ['*'] }]
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const selected = await probePandoc(result.filePaths[0])
    if (!selected) return { ok: false, error: 'The selected file is not a valid Pandoc executable.' }
    configuredPath = selected.path
    await saveConfig()
    return { ok: true, ...selected, custom: true }
  }

  const exportDocument = async ({ markdown, format, defaultName, sourcePath, figures = [] } = {}) => {
    const descriptor = PANDOC_FORMATS[format]
    if (!descriptor) return { ok: false, code: 'unsupported-format', error: 'Unsupported Pandoc format.' }
    const content = String(markdown || '')
    if (!content.trim()) return { ok: false, code: 'empty-document', error: 'The document is empty.' }
    if (Buffer.byteLength(content, 'utf8') > MAX_MARKDOWN_BYTES) {
      return { ok: false, code: 'document-too-large', error: 'The document is too large to export.' }
    }
    const detected = await detect()
    if (!detected.available) return { ok: false, code: 'not-installed', error: 'Pandoc is not installed or could not be found.' }

    const safeBase = String(defaultName || 'Untitled').replace(/[\\/:*?"<>|]/g, '-').replace(/\.[^.]+$/, '') || 'Untitled'
    // Per-file: default to this document's own folder, or the folder it was
    // last saved to. Other files keep their own defaults.
    const startDir = await getSaveDirFor(sourcePath)
    const save = await dialog.showSaveDialog(getMainWindow(), {
      defaultPath: startDir ? join(startDir, `${safeBase}.${descriptor.extension}`) : `${safeBase}.${descriptor.extension}`,
      filters: [{ name: descriptor.label, extensions: [descriptor.extension] }]
    })
    if (save.canceled || !save.filePath) return { canceled: true }
    await recordSaveDir(sourcePath, dirname(save.filePath))

    const sourceDir = typeof sourcePath === 'string' && isAbsolute(sourcePath) ? dirname(sourcePath) : null
    // Rendered figures (Mermaid / SVG as PNG, see pandoc-figures.js): in a
    // temporary folder Pandoc embeds from, or — LaTeX references image files —
    // in "<name>-figures" next to the .tex.
    let input = content
    let tempDir = null
    let figureCount = 0
    try {
      if (Array.isArray(figures) && figures.length && FIGURE_FORMATS.has(format)) {
        let dir
        let prefix = ''
        if (format === 'latex') {
          const folder = `${basename(save.filePath).replace(/\.[^.]+$/, '')}-figures`
          dir = join(dirname(save.filePath), folder)
          prefix = `${folder}/`
        } else {
          tempDir = await fs.mkdtemp(join(app.getPath('temp'), 'horsemd-pandoc-'))
          dir = tempDir
        }
        const applied = await applyPandocFigures({ markdown: content, figures, dir, prefix, html: format === 'epub' })
        input = applied.markdown
        figureCount = applied.count
        if (!figureCount && format === 'latex') await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      }
      const result = await runSubprocess({
        executable: detected.path,
        args: buildPandocArgs({ outputPath: save.filePath, sourceDir, to: descriptor.to, mathDollars: detected.mathDollars, resourceDirs: tempDir ? [tempDir] : [], delimiter }),
        input,
        cwd: sourceDir || undefined,
        timeoutMs: 120000,
        env: process.env
      })
      if (result.timedOut) return { ok: false, code: 'timeout', error: 'Pandoc timed out after 2 minutes.' }
      if (result.code !== 0) {
        return { ok: false, code: 'pandoc-failed', error: result.stderr.trim() || `Pandoc exited with code ${result.code}.` }
      }
      // Nothing is opened here: the success dialog asks (open the file / show
      // it in its folder), through openResult below.
      lastExportPath = save.filePath
      return {
        ok: true,
        path: save.filePath,
        version: detected.version,
        mathUnsupported: !detected.mathDollars,
        figures: figureCount,
        warning: summarizePandocStderr(result.stderr)
      }
    } catch (error) {
      return { ok: false, code: 'start-failed', error: error?.message || String(error) }
    } finally {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  // The success dialog's buttons. Only the file this module just wrote can be
  // opened — the renderer names an action, never a path.
  let lastExportPath = null
  const openResult = async (kind) => {
    if (!lastExportPath) return { ok: false, error: 'No exported file.' }
    try {
      await fs.access(lastExportPath)
    } catch {
      return { ok: false, code: 'missing', error: lastExportPath }
    }
    if (kind === 'folder') {
      shell.showItemInFolder(lastExportPath)
      return { ok: true }
    }
    const error = await shell.openPath(lastExportPath)
    return error ? { ok: false, error } : { ok: true }
  }

  return { detect, chooseExecutable, exportDocument, openResult }
}
