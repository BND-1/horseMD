import { installPlatformBridge } from './platform' // install window.api bridge (Capacitor on mobile) before App renders
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
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
