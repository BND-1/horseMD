import { sleep } from './cdp.mjs'

const keyCode = (value) => {
  if (value.length !== 1) return 0
  const code = value.toUpperCase().charCodeAt(0)
  return Number.isFinite(code) ? code : 0
}

export async function pressKey(send, {
  key,
  code = key,
  text,
  modifiers = 0,
  delayMs = 12
}) {
  const virtualKeyCode = keyCode(key)
  const common = {
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  }
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    ...common,
    ...(text == null ? {} : { text })
  })
  await sleep(delayMs)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delayMs)
}

// Sends one committed character at a time through Chromium's text-input path.
// This catches incremental Markdown input-rule bugs that bulk insertText hides.
// IME composition is a separate test concern: Chinese characters here represent
// committed text, not the intermediate pinyin/composition candidate lifecycle.
export async function typeTextLikeUser(send, text, {
  delayMs = 18
} = {}) {
  for (const character of [...String(text)]) {
    await send('Input.insertText', { text: character })
    await sleep(delayMs)
  }
}
