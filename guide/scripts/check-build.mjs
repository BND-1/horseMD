import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const guidePackage = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const vercelConfig = JSON.parse(await fs.readFile(path.join(root, 'vercel.json'), 'utf8'))
const dist = path.join(root, '.vitepress', 'dist')
const sitemap = await fs.readFile(path.join(dist, 'sitemap.xml'), 'utf8')
const errors = []

if (/\/public\/|\/fixtures\//.test(sitemap)) errors.push('sitemap contains internal fixture/public routes')
if (!sitemap.includes('https://guide.horsemd.yangsir.net/getting-started/')) {
  errors.push('sitemap is missing the getting-started route')
}
if (vercelConfig.cleanUrls !== true) {
  errors.push('vercel.json must enable cleanUrls so VitePress routes do not return 404')
}

for (const asset of [
  'icon.png',
  'favicon.ico',
  'robots.txt',
  'llms.txt',
  'basics/interface.html',
  `images/v${guidePackage.version}/interface-overview.png`
]) {
  try {
    await fs.access(path.join(dist, asset))
  } catch {
    errors.push(`build output is missing ${asset}`)
  }
}

if (errors.length) {
  console.error(`Guide build check failed (${errors.length})`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log('PASS guide build output: sitemap and public assets')
