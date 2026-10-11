import { open, sleep } from './probe-session.mjs'
const fixture = '﻿' + ['# t', '', '> intro', '>', '> second', '>', '> 1. quote-one', '> 2. quote-two', '', 'after', ''].join('\r\n')
const s = await open('quote-list-exit', fixture)
const dump = async (label) => {
  const out = await s.app.evaluate(`JSON.stringify({
    src: globalThis.__hmSourceReprintHarness.liveSource(),
    reprint: (globalThis.__hmSourceReprintTrace||[]).slice(-3),
    coord: (globalThis.__hmSourceSyncCoordinatorTrace||[]).slice(-3).map(e=>[e.phase,e.family,e.reason]),
    pm: [...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent).pmViewDesc.node.child(1).toJSON()
  })`)
  console.log(label, out)
}
try {
  await s.clickText('quote-two')
  await s.key('End'); await s.key('Enter'); await sleep(900); await dump('AFTER1')
  await s.key('Enter'); await sleep(1000); await dump('AFTER2')
  await s.type('X'); await sleep(1000); await dump('AFTER3')
  console.log('toasts', await s.toasts())
} finally { await s.close() }
