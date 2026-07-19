import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const guideRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(guideRoot, '..')
const publicRoot = path.join(guideRoot, 'public')
const contentDirs = [
  'getting-started',
  'basics',
  'editing',
  'productivity',
  'output',
  'customization',
  'mobile',
  'troubleshooting'
]
const errors = []

async function listFiles(dir, extension) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(full, extension)))
    else if (!extension || entry.name.endsWith(extension)) files.push(full)
  }
  return files
}

function routeToMarkdown(route) {
  const clean = decodeURIComponent(route.split(/[?#]/)[0])
  if (clean === '/') return path.join(guideRoot, 'index.md')
  if (clean.endsWith('/')) return path.join(guideRoot, clean, 'index.md')
  return path.join(guideRoot, `${clean}.md`)
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

const guidePackage = JSON.parse(await fs.readFile(path.join(guideRoot, 'package.json'), 'utf8'))
const version = guidePackage.version
const parseVersion = (value) => String(value).split('.').map((part) => Number.parseInt(part, 10) || 0)
const compareVersion = (left, right) => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0)
  }
  return 0
}
const appPackagePath = path.join(repoRoot, 'package.json')
if (await exists(appPackagePath)) {
  const appPackage = JSON.parse(await fs.readFile(appPackagePath, 'utf8'))
  if (compareVersion(appPackage.version, version) < 0) {
    errors.push(`guide baseline v${version} cannot be newer than app version v${appPackage.version}`)
  } else if (appPackage.version !== version) {
    console.warn(`guide baseline v${version}; app is a newer test build v${appPackage.version}`)
  }
}
const markdownFiles = [path.join(guideRoot, 'index.md')]
for (const dir of contentDirs) markdownFiles.push(...(await listFiles(path.join(guideRoot, dir), '.md')))

if (markdownFiles.length < 30) errors.push(`Expected a complete guide, found only ${markdownFiles.length} pages`)

const titles = new Map()
const referencedImages = new Set()
for (const file of markdownFiles) {
  const relative = path.relative(guideRoot, file)
  const source = await fs.readFile(file, 'utf8')
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatter) {
    errors.push(`${relative}: missing frontmatter`)
    continue
  }
  const title = frontmatter[1].match(/^title:\s*(.+)$/m)?.[1]?.trim()
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!title) errors.push(`${relative}: missing title`)
  if (!description) errors.push(`${relative}: missing description`)
  if (title) {
    if (titles.has(title)) errors.push(`${relative}: duplicate title with ${titles.get(title)}: ${title}`)
    titles.set(title, relative)
  }
  if (!/HorseMD v\d+\.\d+\.\d+/.test(source)) errors.push(`${relative}: missing a HorseMD version badge`)
  if (/\/Users\/[^/]+|file:\/\/\/[A-Za-z]:\//.test(source)) errors.push(`${relative}: contains a private local path`)

  for (const match of source.matchAll(/\]\((\/[^)\s]+)\)/g)) {
    const target = match[1]
    if (target.startsWith('/images/') || target.startsWith('/downloads/')) {
      const asset = path.join(publicRoot, decodeURIComponent(target))
      referencedImages.add(asset)
      if (!(await exists(asset))) errors.push(`${relative}: missing public asset ${target}`)
    } else if (!(await exists(routeToMarkdown(target)))) {
      errors.push(`${relative}: dead internal link ${target}`)
    }
  }
  for (const match of source.matchAll(/href="(\/[^"#?]+)"/g)) {
    if (!(await exists(routeToMarkdown(match[1])))) errors.push(`${relative}: dead HTML link ${match[1]}`)
  }
}

const config = await fs.readFile(path.join(guideRoot, '.vitepress/config.mjs'), 'utf8')
for (const match of config.matchAll(/link:\s*'(\/[^']+)'/g)) {
  if (!(await exists(routeToMarkdown(match[1])))) errors.push(`config.mjs: dead navigation link ${match[1]}`)
}

const screenshotDir = path.join(publicRoot, 'images', `v${version}`)
const screenshots = await listFiles(screenshotDir, '.png')
if (screenshots.length < 8) errors.push(`Expected at least 8 current screenshots, found ${screenshots.length}`)
for (const screenshot of screenshots) {
  const data = await fs.readFile(screenshot)
  const width = data.readUInt32BE(16)
  const height = data.readUInt32BE(20)
  if (width !== 1440 || height !== 900) {
    errors.push(`${path.relative(guideRoot, screenshot)}: expected 1440x900, got ${width}x${height}`)
  }
  if (!referencedImages.has(screenshot)) {
    errors.push(`${path.relative(guideRoot, screenshot)}: screenshot is not used by any guide page`)
  }
}

const websiteFiles = ['index.html', 'index.md', 'app.js', 'llms.txt', 'llms-full.txt']
const websiteRoot = path.join(repoRoot, 'website')
if (await exists(websiteRoot)) {
  for (const name of websiteFiles) {
    const source = await fs.readFile(path.join(websiteRoot, name), 'utf8')
    if (source.includes('v0.5.0') || source.includes('"softwareVersion": "0.5.0"')) {
      errors.push(`website/${name}: stale v0.5.0 metadata`)
    }
  }
}

const guideLlms = await fs.readFile(path.join(publicRoot, 'llms.txt'), 'utf8')
if (!guideLlms.includes(`HorseMD v${version}`)) errors.push(`public/llms.txt: missing current version v${version}`)

if (errors.length) {
  console.error(`Guide content check failed (${errors.length})`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`PASS guide content: ${markdownFiles.length} pages, ${screenshots.length} screenshots, version v${version}`)
