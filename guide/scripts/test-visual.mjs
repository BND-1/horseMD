import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const baseUrl = process.env.GUIDE_URL || 'http://127.0.0.1:4174'
const websiteUrl = process.env.WEBSITE_URL || ''
const chromePath = process.env.CHROME_PATH || (
  process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome'
)
const outputDir = path.join(os.tmpdir(), 'horsemd-guide-visual')
await fs.rm(outputDir, { recursive: true, force: true })
await fs.mkdir(outputDir, { recursive: true })

const browser = await chromium.launch({ executablePath: chromePath, headless: true })
const errors = []

async function assertLayout(page, label) {
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    title: document.title,
    h1: document.querySelector('h1')?.textContent?.trim() || ''
  }))
  if (layout.scrollWidth > layout.viewport + 1) {
    errors.push(`${label}: horizontal overflow ${layout.scrollWidth}px > ${layout.viewport}px`)
  }
  if (!layout.title || !layout.h1) errors.push(`${label}: missing title or h1`)
}

async function openPage(page, route, label) {
  const response = await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' })
  if (!response?.ok()) errors.push(`${label}: HTTP ${response?.status() || 'no response'}`)
  await page.locator('h1').first().waitFor()
  await assertLayout(page, label)
}

async function revealWholePage(page, label) {
  await page.evaluate(async () => {
    for (const element of document.querySelectorAll('.reveal')) {
      element.scrollIntoView({ block: 'center' })
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    window.scrollTo(0, 0)
  })
  const hidden = await page.locator('.reveal:not(.in)').evaluateAll((elements) =>
    elements.map((element) => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 8)
  )
  if (hidden.length) errors.push(`${label}: reveal elements stayed hidden: ${hidden.join(', ')}`)
}

try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
  const page = await desktop.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`desktop console: ${message.text()} (${message.location().url || 'unknown'})`)
  })
  page.on('pageerror', (error) => errors.push(`desktop page: ${error.message}`))
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`desktop response: ${response.status()} ${response.url()}`)
  })

  await openPage(page, '/', 'desktop home')
  await page.screenshot({ path: path.join(outputDir, 'desktop-home.png'), fullPage: true })

  await openPage(page, '/basics/interface', 'desktop article')
  await page.screenshot({ path: path.join(outputDir, 'desktop-article.png'), fullPage: true })

  await page.getByRole('button', { name: /搜索教程/ }).click()
  const searchInput = page.locator('.VPLocalSearchBox input')
  await searchInput.fill('源码模式')
  const results = page.locator('.VPLocalSearchBox .result')
  await results.first().waitFor()
  if ((await results.count()) < 1) errors.push('search: no results for 源码模式')
  await page.screenshot({ path: path.join(outputDir, 'desktop-search.png') })
  await page.keyboard.press('Escape')

  const docImage = page.locator('.vp-doc img:not(.no-zoom)').first()
  await docImage.click()
  await page.locator('.hm-lightbox').waitFor()
  await page.screenshot({ path: path.join(outputDir, 'desktop-lightbox.png') })
  await page.keyboard.press('Escape')
  if (await page.locator('.hm-lightbox').count()) errors.push('lightbox: Escape did not close preview')

  const appearance = page.locator('.VPSwitchAppearance:visible').first()
  if (await appearance.count()) {
    await appearance.click()
    await page.waitForTimeout(150)
    if (!(await page.locator('html.dark').count())) errors.push('appearance: dark mode did not activate')
    await page.screenshot({ path: path.join(outputDir, 'desktop-dark.png'), fullPage: true })
  }
  await desktop.close()

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    isMobile: true,
    hasTouch: true
  })
  const mobilePage = await mobile.newPage()
  mobilePage.on('console', (message) => {
    if (message.type() === 'error') errors.push(`mobile console: ${message.text()} (${message.location().url || 'unknown'})`)
  })
  mobilePage.on('pageerror', (error) => errors.push(`mobile page: ${error.message}`))
  mobilePage.on('response', (response) => {
    if (response.status() >= 400) errors.push(`mobile response: ${response.status()} ${response.url()}`)
  })

  await openPage(mobilePage, '/', 'mobile home')
  await mobilePage.locator('.VPNavBarHamburger').click()
  await mobilePage.locator('.VPNavScreen').waitFor()
  await mobilePage.screenshot({ path: path.join(outputDir, 'mobile-navigation.png') })

  await openPage(mobilePage, '/editing/slash-command', 'mobile article')
  await mobilePage.screenshot({ path: path.join(outputDir, 'mobile-article.png'), fullPage: true })
  await mobile.close()

  if (websiteUrl) {
    const website = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', locale: 'zh-CN' })
    const websitePage = await website.newPage()
    websitePage.on('pageerror', (error) => errors.push(`website page: ${error.message}`))
    const response = await websitePage.goto(websiteUrl, { waitUntil: 'domcontentloaded' })
    if (!response?.ok()) errors.push(`website: HTTP ${response?.status() || 'no response'}`)
    await websitePage.locator('.hero-title').waitFor()
    await assertLayout(websitePage, 'website desktop')
    const guideLink = websitePage.locator('.nav-links a[href="https://guide.horsemd.yangsir.net/"]')
    if ((await guideLink.count()) !== 1) errors.push('website: guide navigation link missing')
    if ((await guideLink.textContent())?.trim() !== '教程') errors.push('website: Chinese guide label is incorrect')
    await websitePage.locator('#langToggle').click()
    if ((await guideLink.textContent())?.trim() !== 'GUIDE') errors.push('website: English guide label did not update')
    await revealWholePage(websitePage, 'website desktop')
    await websitePage.screenshot({ path: path.join(outputDir, 'website-desktop.png'), fullPage: true })
    await website.close()

    const websiteMobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', locale: 'zh-CN', isMobile: true })
    const websiteMobilePage = await websiteMobile.newPage()
    await websiteMobilePage.goto(websiteUrl, { waitUntil: 'domcontentloaded' })
    await websiteMobilePage.locator('.hero-title').waitFor()
    await assertLayout(websiteMobilePage, 'website mobile')
    await revealWholePage(websiteMobilePage, 'website mobile')
    await websiteMobilePage.screenshot({ path: path.join(outputDir, 'website-mobile.png'), fullPage: true })
    await websiteMobile.close()
  }
} finally {
  await browser.close()
}

if (errors.length) {
  console.error(`Guide visual test failed (${errors.length})`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`PASS guide visual: desktop, mobile, search, lightbox, dark mode; screenshots in ${outputDir}`)
