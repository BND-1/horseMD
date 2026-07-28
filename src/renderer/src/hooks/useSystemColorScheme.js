import { useEffect, useState } from 'react'

const QUERY = '(prefers-color-scheme: dark)'

const readSystemDark = () => window.matchMedia?.(QUERY).matches === true

// Keep the renderer in step with the operating system without routing a theme
// switch through Electron IPC. `change` fires immediately when macOS, Windows,
// Linux, iOS, or Android changes its appearance preference.
export function useSystemColorScheme() {
  const [isDark, setIsDark] = useState(readSystemDark)

  useEffect(() => {
    const media = window.matchMedia?.(QUERY)
    if (!media) return undefined

    const onChange = (event) => setIsDark(event.matches)
    setIsDark(media.matches)
    if (media.addEventListener) {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    // Capacitor can be embedded in older WebViews where MediaQueryList still
    // exposes the legacy listener pair.
    media.addListener?.(onChange)
    return () => media.removeListener?.(onChange)
  }, [])

  return isDark
}
