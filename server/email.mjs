// Lower-cased, trimmed, ≤ 254 chars, one @ with a dot in the domain.
// Anything else (control characters, spaces) is rejected: the address is
// used as a key and handed to the mail service.
const EMAIL_RE = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null
  return email
}
