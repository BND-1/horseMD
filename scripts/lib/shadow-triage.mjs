// Summarize source-reprint shadow results (R2) from fuzz reports.
//   node scripts/lib/shadow-triage.mjs /tmp/horsemd-fuzz/<out> [--verbose]
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
const verbose = process.argv.includes('--verbose')
const window = (left = '', right = '') => {
  let start = 0
  while (start < left.length && left[start] === right[start]) start += 1
  let leftEnd = left.length
  let rightEnd = right.length
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd -= 1; rightEnd -= 1 }
  const from = Math.max(0, start - 40)
  return [JSON.stringify(left.slice(from, leftEnd + 30)), JSON.stringify(right.slice(from, rightEnd + 30))]
}

const totals = { publish: 0, verified: 0, same: 0, failure: 0, rescued: 0 }
const reasons = new Map()
for (const name of readdirSync(root).filter((entry) => entry.startsWith('seed-')).sort()) {
  const file = join(root, name, 'report.json')
  if (!existsSync(file)) continue
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const shadow = report.shadow || []
  const publish = shadow.filter((entry) => entry.phase === 'publish')
  const failure = shadow.filter((entry) => entry.phase === 'failure')
  totals.publish += publish.length
  totals.verified += publish.filter((entry) => entry.verified).length
  totals.same += publish.filter((entry) => entry.sameAsCurrent).length
  totals.failure += failure.length
  totals.rescued += failure.filter((entry) => entry.verified).length
  console.log(`${name}: publish ${publish.length} verified ${publish.filter((e) => e.verified).length} same ${publish.filter((e) => e.sameAsCurrent).length} | failure ${failure.length} rescued ${failure.filter((e) => e.verified).length} | maxMs ${Math.max(0, ...shadow.map((e) => e.ms || 0))}`)
  for (const entry of shadow) {
    if (entry.verified && entry.sameAsCurrent !== false) continue
    const key = entry.verified ? 'verified-but-different' : `unverified:${entry.reason}`
    reasons.set(key, (reasons.get(key) || 0) + 1)
    if (!verbose) continue
    console.log(`  op ${entry.opIndex} ${entry.phase} ${key} levels=${JSON.stringify(entry.levels)}`)
    if (entry.verified) {
      const [current, reprinted] = window(entry.current, entry.reprinted)
      console.log(`    current  ${current}\n    reprint  ${reprinted}`)
    } else if (entry.attempted != null) {
      const [previous, attempted] = window(entry.previous, entry.attempted)
      console.log(`    previous ${previous}\n    attempt  ${attempted}`)
    }
  }
}
console.log('TOTAL', JSON.stringify(totals))
console.log('NON-IDEAL', JSON.stringify(Object.fromEntries(reasons)))
