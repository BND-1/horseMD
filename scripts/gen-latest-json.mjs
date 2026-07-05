// 生成 website/latest.json —— app 的国内更新检查源(官网托管,GitHub API 作回退)。
// 每次 GitHub 发版后跑一次:node scripts/gen-latest-json.mjs
// 然后提交 website/latest.json 并重新部署官网。
import { writeFileSync } from 'node:fs'

const res = await fetch('https://api.github.com/repos/BND-1/horseMD/releases/latest', {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HorseMD-Updater' }
})
if (!res.ok) {
  console.error('GitHub fetch failed:', res.status, res.statusText)
  process.exit(1)
}
const d = await res.json()
const out = {
  latest: String(d.tag_name || '').replace(/^v/i, ''),
  name: typeof d.name === 'string' ? d.name : '',
  url: d.html_url || 'https://github.com/BND-1/horseMD/releases',
  // 与 app 端一致的 4000 字符上限,避免 changelog 过长撑爆 IPC / toast。
  notes: typeof d.body === 'string' ? d.body.slice(0, 4000) : ''
}
writeFileSync('website/latest.json', JSON.stringify(out, null, 2) + '\n')
console.log(`wrote website/latest.json → v${out.latest} (${out.notes.length} chars of notes)`)
