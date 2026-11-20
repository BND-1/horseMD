import { appendFileSync } from 'node:fs'

const subject = (code) => `HorseMD 登录验证码：${code}`
const text = (code) => [
  `你的 HorseMD 登录验证码是 ${code}`,
  '',
  '10 分钟内有效。如果不是你本人在登录，请忽略这封邮件，你的账号不会有任何变化。',
  '',
  '— HorseMD'
].join('\n')
const html = (code) => `<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:15px;color:#333;line-height:1.6">
<p>你的 HorseMD 登录验证码是</p>
<p style="font-size:28px;font-weight:600;letter-spacing:6px;margin:12px 0">${code}</p>
<p>10 分钟内有效。如果不是你本人在登录，请忽略这封邮件，你的账号不会有任何变化。</p>
<p style="color:#999">— HorseMD</p>
</div>`

// `log`: the development mailbox. Codes go to HM_MAIL_LOG (one JSON line
// each, for tests) or to the console. Never use it in production.
// `resend`: https://resend.com/docs/api-reference/emails/send-email
export function createMailer({ driver = 'log', logFile = '', resendKey = '', from = '', fetch = globalThis.fetch, now = Date.now, log = console } = {}) {
  if (driver === 'log') {
    return {
      driver,
      async send({ email, code }) {
        const line = JSON.stringify({ email, code, at: new Date(now()).toISOString() })
        if (logFile) appendFileSync(logFile, `${line}\n`, { mode: 0o600 })
        else log.log(`[mail] ${line}`)
      }
    }
  }
  if (driver === 'resend') {
    if (!resendKey || !from) throw new Error('HM_MAIL=resend 需要同时设置 HM_RESEND_KEY 和 HM_MAIL_FROM。')
    return {
      driver,
      async send({ email, code }) {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: [email], subject: subject(code), text: text(code), html: html(code) }),
          signal: AbortSignal.timeout(15000)
        })
        if (!response.ok) {
          let name = ''
          try { name = (await response.json())?.name || '' } catch { /* status is enough */ }
          throw new Error(`Resend HTTP ${response.status}${name ? ` ${name}` : ''}`)
        }
      }
    }
  }
  throw new Error(`未知的 HM_MAIL：${driver}（可选 log 或 resend）`)
}
