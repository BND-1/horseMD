// Default Markdown editor (#170): pure helpers in src/main/default-app-core.js.
import assert from 'node:assert/strict'
import {
  desktopExecProgram,
  parseDesktopEntry,
  pickLinuxDesktopFile,
  windowsAppName,
  windowsCommandExe,
  windowsDefaultState
} from '../src/main/default-app-core.js'

const EXE = 'C:\\Users\\杨\\AppData\\Local\\Programs\\HorseMD\\HorseMD.exe'

// Windows open commands
assert.equal(windowsCommandExe(`"${EXE}" "%1"`), EXE)
assert.equal(windowsCommandExe('C:\\Windows\\system32\\NOTEPAD.EXE %1'), 'C:\\Windows\\system32\\NOTEPAD.EXE')
assert.equal(windowsCommandExe('"C:\\Program Files\\Typora\\Typora.exe" "%1"'), 'C:\\Program Files\\Typora\\Typora.exe')
assert.equal(windowsCommandExe(''), '')
assert.equal(windowsCommandExe(null), '')

assert.equal(windowsAppName({ progId: 'Typora.md', command: '"C:\\Program Files\\Typora\\Typora.exe" "%1"' }), 'Typora')
assert.equal(windowsAppName({ progId: 'Applications\\Code.exe', command: null }), 'Code')
assert.equal(windowsAppName({ progId: 'AppX4ztfk9wxr86nxmzzq47px0nh0e58b8fw', command: null }), 'AppX4ztfk9wxr86nxmzzq47px0nh0e58b8fw')
assert.equal(windowsAppName({}), '')

// Default = .md's command runs this exe (case / slash insensitive).
assert.deepEqual(windowsDefaultState(JSON.stringify({ '.md': { progId: 'Markdown Document', command: `"${EXE.toLowerCase()}" "%1"`, source: 'user' } }), EXE), { isDefault: true, current: '' })
assert.deepEqual(windowsDefaultState({ '.md': { progId: 'Applications\\notepad.exe', command: 'C:\\Windows\\system32\\NOTEPAD.EXE %1' } }, EXE), { isDefault: false, current: 'NOTEPAD' })
// Another app that also uses the generic ProgId "Markdown Document".
assert.deepEqual(windowsDefaultState({ '.md': { progId: 'Markdown Document', command: '"D:\\Other\\Other.exe" "%1"' } }, EXE), { isDefault: false, current: 'Other' })
assert.deepEqual(windowsDefaultState('not json', EXE), { isDefault: false, current: '' })
assert.deepEqual(windowsDefaultState({}, EXE), { isDefault: false, current: '' })

// Linux desktop files
const ours = '[Desktop Entry]\nName=HorseMD\nExec=/opt/HorseMD/horse %U\nType=Application\nMimeType=text/markdown;text/x-markdown;\n\n[Desktop Action new]\nExec=/opt/HorseMD/horse --new\n'
assert.deepEqual(parseDesktopEntry(ours), { Name: 'HorseMD', Exec: '/opt/HorseMD/horse %U', Type: 'Application', MimeType: 'text/markdown;text/x-markdown;' })
assert.equal(desktopExecProgram('/opt/HorseMD/horse %U'), '/opt/HorseMD/horse')
assert.equal(desktopExecProgram('"/opt/Horse MD/horse" %f'), '/opt/Horse MD/horse')
assert.equal(desktopExecProgram('env ELECTRON_OZONE=1 FOO=x horse %U'), 'horse')
assert.equal(desktopExecProgram(''), '')
const candidates = [
  { id: 'other.desktop', text: '[Desktop Entry]\nExec=/usr/bin/typora %U', programPath: '/usr/share/typora/Typora' },
  { id: 'horse-old.desktop', text: '[Desktop Entry]\nExec=/opt/HorseMD/horse', programPath: '/opt/HorseMD/horse' },
  { id: 'horse.desktop', text: ours, programPath: '/opt/HorseMD/horse' }
]
assert.equal(pickLinuxDesktopFile(candidates, '/opt/HorseMD/horse'), 'horse.desktop')
assert.equal(pickLinuxDesktopFile(candidates.slice(0, 2), '/opt/HorseMD/horse'), 'horse-old.desktop')
assert.equal(pickLinuxDesktopFile(candidates, '/elsewhere/horse'), null)

console.log('PASS default-app core')
