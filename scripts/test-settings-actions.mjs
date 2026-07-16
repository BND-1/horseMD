import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const settingsView = read('src/renderer/src/components/SettingsView.jsx')
const appearanceSettings = read('src/renderer/src/components/settings/AppearanceSettings.jsx')
const statusBar = read('src/renderer/src/components/StatusBar.jsx')
const app = read('src/renderer/src/App.jsx')

assert.match(settingsView, /onOpenThemesFolder,\s*onGetMoreThemes/, 'SettingsView must accept theme action callbacks')
assert.match(settingsView, /onOpenThemesFolder=\{onOpenThemesFolder\}/, 'SettingsView must pass open-theme-folder callback')
assert.match(settingsView, /onGetMoreThemes=\{onGetMoreThemes\}/, 'SettingsView must pass get-more-themes callback')

assert.match(appearanceSettings, /onOpenThemesFolder && onOpenThemesFolder\(\)/, 'Appearance settings must call open-theme-folder callback')
assert.match(appearanceSettings, /onGetMoreThemes && onGetMoreThemes\(\)/, 'Appearance settings must call get-more-themes callback')

assert.match(statusBar, /onOpenThemesFolder\?\.\(\)/, 'Status bar theme menu must call open-theme-folder callback')
assert.match(statusBar, /onGetMoreThemes\?\.\(\)/, 'Status bar theme menu must call get-more-themes callback')

assert.match(app, /onOpenThemesFolder=\{\(\) => window\.api\.themesReveal\?\.\(\)\}/, 'App must wire theme folder action to themesReveal')
assert.match(app, /onGetMoreThemes=\{\(\) => window\.api\.openExternal\('https:\/\/theme\.typora\.io\/'\)\}/, 'App must wire get-more-themes action to Typora theme gallery')

console.log('PASS settings theme actions wiring')
