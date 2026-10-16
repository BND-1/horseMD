// Summarize a fuzz report: node scripts/lib/fuzz-triage.mjs /tmp/horsemd-fuzz/<out>/seed-N
import { readFileSync } from 'node:fs'
const dir = process.argv[2]
const report = JSON.parse(readFileSync(`${dir}/report.json`, 'utf8'))
const first = report.firstPause || report.firstCorrupt
console.log('seed', report.seed, 'pause', JSON.stringify(report.firstPause?.opIndex ?? null), 'corrupt', JSON.stringify(report.firstCorrupt?.diff ?? null))
const at = first?.opIndex ?? report.ops.length
console.log('ops', JSON.stringify(report.ops.filter((op) => op.index >= at - 8 && op.index <= at)))
const trace = report.firstPause?.trace
if (!trace) process.exit(0)
const short = (value) => JSON.stringify(value)
console.log('coordinator', short(trace.coordinator.slice(-5).map((entry) => [entry.revision, entry.phase, entry.family, entry.reason])))
console.log('flush', short(trace.flush.slice(-4).map((entry) => [entry.phase, entry.force, entry.reason])))
console.log('journal', short(trace.journal.slice(-3).map((entry) => [entry.phase, entry.reason, entry.batchCount, (entry.stepDetails || []).slice(-4)])))
for (const [key, list] of Object.entries(trace.owners || {})) {
  const last = list[list.length - 1]
  if (last && (last.recognized || last.legacyBlocked || last.ok)) console.log('owner', key, short(last).slice(0, 400))
}
const failed = trace.integrity.filter((entry) => entry.ok === false).slice(-1)[0] || trace.integrity.slice(-1)[0]
if (failed) {
  const candidate = failed.candidate || ''
  const canonical = failed.canonical || ''
  let start = 0
  while (start < candidate.length && candidate[start] === canonical[start]) start += 1
  let ce = candidate.length; let ke = canonical.length
  while (ce > start && ke > start && candidate[ce - 1] === canonical[ke - 1]) { ce -= 1; ke -= 1 }
  console.log('integrity', failed.validationSite, failed.preservationReason, 'ok', failed.ok)
  console.log('  candidate', short(candidate.slice(Math.max(0, start - 60), ce + 40)))
  console.log('  canonical', short(canonical.slice(Math.max(0, start - 60), ke + 40)))
}
