import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'

const repoRoot = process.cwd()
const fixture = (...parts) => path.join(repoRoot, 'scripts', 'fixtures', ...parts)
const realLargeDoc = '/Users/yangtingyi/vibe_everything/置身钉内/MinerU_markdown_置身钉内_14.34.50_2064164636132720640.md'
const realComputerDoc = '/Users/yangtingyi/vibe_everything/电脑档案.md'

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function runNode(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${script} failed with ${signal || code}`))
    })
  })
}

async function runSession({ name, port, profileDir, appArgs = [], tests }) {
  console.log(`\n[ui-regression] ${name}`)
  const app = await launchBuiltElectron({
    profileDir,
    port,
    appArgs
  })
  try {
    for (const test of tests) {
      await runNode(test.script, test.args || [], {
        CDP_PORT: String(port),
        ...(test.env || {})
      })
    }
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

const sessions = [
  {
    name: 'issues 57-60: LaTeX, inline code, PDF entry',
    port: 9480,
    profileDir: '/tmp/horsemd-ui-regression-57-60',
    appArgs: [fixture('issues-57-60.md')],
    tests: [{ script: 'scripts/test-issues-57-60-ui.mjs' }]
  },
  {
    name: 'PDF studio',
    port: 9481,
    profileDir: '/tmp/horsemd-ui-regression-pdf',
    appArgs: [fixture('issues-57-60.md')],
    tests: [{ script: 'scripts/test-pdf-studio-ui.mjs' }]
  },
  {
    name: 'Review UI',
    port: 9482,
    profileDir: '/tmp/horsemd-ui-regression-review',
    tests: [{ script: 'scripts/test-review-ui.mjs' }]
  },
  {
    name: 'Lightbox',
    port: 9483,
    profileDir: '/tmp/horsemd-ui-regression-lightbox',
    appArgs: [fixture('lightbox-aspect.md')],
    tests: [{ script: 'scripts/test-lightbox-ui.mjs' }]
  },
  {
    name: 'Table scroll and table controls',
    port: 9484,
    profileDir: '/tmp/horsemd-ui-regression-table',
    appArgs: [fixture('table-scroll.md')],
    tests: [{ script: 'scripts/test-table-scroll-ui.mjs' }]
  },
  {
    name: 'Issues 66-67: split outline and bold/sidebar shortcuts',
    port: 9485,
    profileDir: '/tmp/horsemd-ui-regression-66-67',
    appArgs: [fixture('outline-split-left.md'), fixture('outline-split-right.md')],
    tests: [{ script: 'scripts/test-issues-66-67-ui.mjs' }]
  }
]

const standalone = [
  {
    name: 'Issues 70-72: outline fold state and task list input',
    script: 'scripts/test-issues-70-72-ui.mjs'
  },
  {
    name: 'Issues 74-75: inline math deletion and font picker names',
    script: 'scripts/test-issues-74-75-ui.mjs'
  },
  {
    name: 'Editor style settings: source font and custom CSS preview',
    script: 'scripts/test-editor-style-settings-ui.mjs'
  },
  {
    name: 'PDF LaTeX: display math prints rendered output',
    script: 'scripts/test-pdf-latex-ui.mjs'
  }
]

if (await exists(realLargeDoc)) {
  sessions.push(
    {
      name: 'Large document mode switch 10x',
      port: 9486,
      profileDir: '/tmp/horsemd-ui-regression-large-switch',
      appArgs: [realLargeDoc],
      tests: [{ script: 'scripts/test-mode-switch-10x.mjs' }]
    },
    {
      name: 'Large document source find',
      port: 9487,
      profileDir: '/tmp/horsemd-ui-regression-source-find',
      appArgs: [realLargeDoc],
      tests: [{
        script: 'scripts/test-source-find.mjs',
        args: ['--mode-switch'],
        env: { FIND_QUERY: '企业' }
      }]
    }
  )
} else {
  console.warn(`[ui-regression] skip real large document: ${realLargeDoc}`)
}

if (await exists(realComputerDoc)) {
  sessions.push({
    name: '电脑档案 mode switch chains',
    port: 9488,
    profileDir: '/tmp/horsemd-ui-regression-computer-switch',
    appArgs: [realComputerDoc],
    tests: [{
      script: 'scripts/test-mode-switch-chains.mjs',
      env: { CHAIN_RATIOS: '0.2,0.5,0.8' }
    }]
  })
} else {
  console.warn(`[ui-regression] skip real computer document: ${realComputerDoc}`)
}

for (const session of sessions) {
  await runSession(session)
}

for (const item of standalone) {
  console.log(`\n[ui-regression] ${item.name}`)
  await runNode(item.script)
}

console.log(`\nPASS UI regression: ${sessions.length} sessions + ${standalone.length} standalone`)
