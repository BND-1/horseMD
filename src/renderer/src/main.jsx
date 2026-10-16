import { installPlatformBridge } from './platform' // install window.api bridge (Capacitor on mobile) before App renders
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
// Keep the vendor CSS before HorseMD overrides in both dev and production.
// Editor.jsx is lazy-loaded: importing these there let frame/reset/table CSS
// arrive AFTER app.css and revert heading fonts, weights and sizing. Only CSS
// is eager; the rich editor JavaScript stays lazy. User theme/snippet styles
// remain later overrides, without extra specificity or !important.
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import '@milkdown/crepe/theme/common/link-tooltip.css'
import '@milkdown/crepe/theme/common/latex.css' // includes KaTeX fonts/layout
import './styles/app.css'

// Desktop resolves immediately (preload already set window.api); mobile awaits
// the Capacitor plugin chunk. Either way App never renders without window.api.
installPlatformBridge()
  .catch(() => {
    /* a failed mobile bridge still renders — features degrade, the shell lives */
  })
  .then(() => {
    createRoot(document.getElementById('root')).render(<App />)
  })
