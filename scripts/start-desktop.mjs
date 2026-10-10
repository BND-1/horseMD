// `npm start` launcher. The npm script used to prefix electron-vite with
// `cross-env ELECTRON_RUN_AS_NODE=` to clear a leaked variable, but Electron
// (>= 34 on Windows) treats a present-but-EMPTY ELECTRON_RUN_AS_NODE as node
// mode too, so the app crashed with "app.requestSingleInstanceLock of
// undefined". Deleting the variable before spawning fixes that while keeping
// the original intent (never inherit node mode from the calling environment).
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('..', import.meta.url)))
delete process.env.ELECTRON_RUN_AS_NODE
const cli = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [cli, 'preview', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root
})
child.on('close', (code) => process.exit(code ?? 0))
