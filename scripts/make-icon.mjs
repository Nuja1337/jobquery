// Renders resources/icon.svg to build/icon.png (1024x1024) with the Chrome or Edge already on this computer.
// electron-builder reads build/icon.png and makes the Windows, macOS and Linux icons from it.
// Run with: node scripts/make-icon.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = path.join(root, 'resources', 'icon.svg')
const pngPath = path.join(root, 'build', 'icon.png')

function findBrowser() {
  const local = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    local
  ]
  return candidates.find((p) => p && fs.existsSync(p))
}

const executablePath = findBrowser()
if (!executablePath) {
  console.error('Chrome or Edge was not found. Install one of them and run this again.')
  process.exit(1)
}

const svg = fs.readFileSync(svgPath, 'utf8')
fs.mkdirSync(path.dirname(pngPath), { recursive: true })

const browser = await chromium.launch({ executablePath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`)
  await page.screenshot({ path: pngPath, omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } })
} finally {
  await browser.close()
}
console.log(`Wrote ${path.relative(root, pngPath)}`)
