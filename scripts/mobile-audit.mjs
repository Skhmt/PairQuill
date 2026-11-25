// Mobile-usability audit: loads the built app on narrow touch viewports and gates
// PASS/FAIL on the issues fixed in the mobile pass (top bar clipping, Servers modal
// panes, hover-only story actions, <16px form fields). Read-only; safe to re-run.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VIEWPORTS = [
  { name: '375x667 (iPhone)', width: 375, height: 667 },
  { name: '360x800 (Android)', width: 360, height: 800 },
  { name: '320x568 (small phone)', width: 320, height: 568 },
]

const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height }, hasTouch: true, isMobile: true })
page.setDefaultTimeout(8000)

let failures = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

await page.goto('file:///' + path.join(root, 'dist', 'index.html').replace(/\\/g, '/'))
await page.waitForSelector('footer')

// Create a story so the top bar shows its full generation-control row.
await page.click('button:has-text("New story")')
await page.waitForTimeout(400)

// ---- 1. Top bar fits every narrow viewport (no clipped controls) --------------
for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.width, height: vp.height })
  await page.waitForTimeout(150)
  const m = await page.evaluate(() => {
    const header = document.querySelector('header')
    const clipped = [...header.querySelectorAll('button, input[type="range"], span')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)
      })
      .map((el) => el.tagName + (el.getAttribute('aria-label') ? ':' + el.getAttribute('aria-label') : ''))
    const btns = [...header.querySelectorAll('button')]
    const cont = btns.find((b) => b.textContent.includes('Continue') || (b.title || '').includes('Stop'))
    const cr = cont ? cont.getBoundingClientRect() : null
    return {
      headerH: Math.round(header.getBoundingClientRect().height),
      clipped,
      continueRight: cr ? Math.round(cr.right) : null,
      innerWidth: window.innerWidth,
    }
  })
  check(
    `top bar unclipped @${vp.name}`,
    m.clipped.length === 0 && m.headerH <= 120,
    `h=${m.headerH}px (rows≈${Math.ceil(m.headerH / 48)}), clipped=[${m.clipped.join(', ')}]`,
  )
  check(`Continue reachable @${vp.name}`, m.continueRight !== null && m.continueRight <= vp.width + 1, `right=${m.continueRight}/${vp.width}`)
}

// ---- 2. Status bar: few wrap rows + no iOS zoom (<16px fields) -----------------
await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height })
const sb = await page.evaluate(() => {
  const footer = document.querySelector('footer')
  return {
    h: Math.round(footer.getBoundingClientRect().height),
    fonts: [...footer.querySelectorAll('select')].map((s) => getComputedStyle(s).fontSize),
  }
})
check('status bar ≤ 2 rows @375', sb.h <= 64, `h=${sb.h}px`)
check('status bar selects ≥16px (iOS zoom guard)', sb.fonts.length > 0 && sb.fonts.every((f) => parseFloat(f) >= 16), sb.fonts.join(', '))

// ---- 3. Servers modal: editor pane gets full width on phones -------------------
await page.click('footer button[title="Server & model settings"]')
await page.waitForSelector('[data-profile-editor]')
const sv = await page.evaluate(() => {
  const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null)
  return {
    editor: w(document.querySelector('[data-profile-editor]')),
    input: w(document.querySelector('[data-profile-editor] input.input-bordered')),
  }
})
check('servers modal editor usable @375', sv.editor >= 240 && (sv.input ?? 0) >= 200, `editor=${sv.editor}px, first input=${sv.input}px`)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

// ---- 4. Stories row actions visible on touch (no hover) ------------------------
await page.click('header button[title="Menu"]')
const menu = page.locator('[role="menu"]')
await menu.getByRole('menuitem', { name: 'Stories', exact: true }).click()
await page.waitForSelector('[aria-label="Stories"] .modal-box')
const st = await page.evaluate(() =>
  [...document.querySelectorAll('[aria-label="Stories"] button[title]')]
    .filter((b) => ['Rename story', 'Export as .txt', 'Delete story'].includes(b.title))
    .slice(0, 3)
    .map((b) => ({ t: b.title, o: getComputedStyle(b).opacity })),
)
check('story row actions visible on touch @375', st.length === 3 && st.every((x) => x.o !== '0'), JSON.stringify(st))
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

// ---- 5. Hamburger menu fits the viewport ---------------------------------------
await page.click('header button[title="Menu"]')
const md = await page.evaluate(() => {
  const m = document.querySelector('[role="menu"]')
  if (!m) return null
  const r = m.getBoundingClientRect()
  return { h: Math.round(r.height), bottom: Math.round(r.bottom), vh: window.innerHeight }
})
check('hamburger menu fits viewport @375', !!md && md.bottom <= md.vh + 1, md ? `bottom=${md.bottom}/${md.vh}px` : 'menu not found')

await browser.close()
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL MOBILE CHECKS PASSED')
process.exit(failures ? 1 : 0)
