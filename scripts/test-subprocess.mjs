import assert from 'node:assert/strict'
import { runSubprocess } from '../src/main/subprocess.js'

const success = await runSubprocess({
  executable: process.execPath,
  args: ['-e', 'process.stdin.pipe(process.stdout)'],
  input: 'HorseMD 子进程测试',
  timeoutMs: 2000
})
assert.equal(success.code, 0)
assert.equal(success.stdout, 'HorseMD 子进程测试')
assert.equal(success.timedOut, false)

const failed = await runSubprocess({
  executable: process.execPath,
  args: ['-e', "process.stderr.write('expected error'); process.exit(7)"],
  timeoutMs: 2000
})
assert.equal(failed.code, 7)
assert.equal(failed.stderr, 'expected error')

const timedOut = await runSubprocess({
  executable: process.execPath,
  args: ['-e', 'setTimeout(() => {}, 5000)'],
  timeoutMs: 100
})
assert.equal(timedOut.timedOut, true)

console.log('subprocess tests passed')

