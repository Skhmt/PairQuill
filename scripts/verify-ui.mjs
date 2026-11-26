// End-to-end UI verification for the single-top-bar + modal layout (ui-revamp.md):
// unified TopBar (hamburger menu with Stories/World + text styling, generation controls),
// Stories modal (new/rename/import/export/delete), World modal, Context modal,
// StatusBar (no save-state indicator), generation against a self-contained mock
// OpenAI-compatible server (models + SSE chat stream), reply-length slider behavior,
// and the content rating slider (3 stops, guidance injected into every system prompt).
// Logs every step to verify-steps.log.
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const logFile = path.join(root, 'verify-steps.log')
fs.writeFileSync(logFile, '')
const step = (m) => { console.log(m); fs.appendFileSync(logFile, m + '\n') }
const results = []
const pageErrors = []
const check = (name, ok, extra = '') => { results.push({ name, ok }); step(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`) }

const PORT = 9877
const GENERATED = ' The wind picked up, and every lantern along the pier swung in unison.'
let chatHits = 0
let modelsHits = 0
/** Body of the most recent /chat/completions request (lets tests assert on prompt contents). */
let lastChatBody = null
const srv = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', '*'); res.end(); return }
  if ((req.url ?? '').includes('/models')) {
    modelsHits++
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'llama3.1-8b-instruct', context_length: 131072, loaded: true }] }))
    return
  }
  if ((req.url ?? '').includes('/chat/completions')) {
    chatHits++
    const bodyParts = []
    req.on('data', (c) => bodyParts.push(c))
    req.on('end', () => {
      try { lastChatBody = JSON.parse(Buffer.concat(bodyParts).toString('utf8')) } catch { lastChatBody = null }
    })
    res.setHeader('Content-Type', 'text/event-stream')
    const chunks = GENERATED.match(/.{1,12}/gs) ?? []
    let i = 0
    const t = setInterval(() => {
      if (i < chunks.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`)
      } else {
        clearInterval(t)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: GENERATED.length } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }, 25)
    return
  }
  res.statusCode = 404; res.end('{}')
}).listen(PORT, '127.0.0.1')

const hardStop = setTimeout(() => { step('GLOBAL TIMEOUT'); process.exit(3) }, 90_000)
try {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(8000)
  page.on('pageerror', (e) => { pageErrors.push(e.message); step('[pageerror] ' + e.message) })

  // ---- deterministic state: wipe IndexedDB, seed a mock profile ------------
  // First load lets the app boot and flush its debounced save; then we clear all
  // stores and seed one profile + settings pointing at the mock server so every
  // run starts from the same clean slate (no docs, abyss theme).
  await page.goto('file:///' + path.join(root, 'dist', 'index.html').replace(/\\/g, '/'))
  await page.waitForSelector('footer')
  await page.waitForTimeout(1600)
  await page.evaluate(async (port) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('pairquill', 1)
      r.onupgradeneeded = () => {
        const d = r.result
        for (const [name, keyPath] of [['documents', 'id'], ['profiles', 'id'], ['settings', null], ['generations', 'id']]) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, keyPath ? { keyPath } : {})
        }
      }
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction(['documents', 'profiles', 'settings', 'generations'], 'readwrite')
    tx.objectStore('documents').clear()
    tx.objectStore('generations').clear()
    tx.objectStore('profiles').put({
      id: 'mock-profile', name: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '',
      modelId: 'llama3.1-8b-instruct', systemPromptTemplate: '',
      params: { temperature: 0.8, topP: 1, maxTokens: 0, stopSequences: [] },
    })
    tx.objectStore('settings').put(
      { theme: 'abyss', activeProfileId: 'mock-profile', activeDocId: null, fontSize: 'md', measure: 'normal', fontFamily: 'serif' },
      'app',
    )
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
    db.close()
  }, PORT)
  await page.reload()
  await page.waitForSelector('footer')
  await page.waitForTimeout(500)

  const ta = page.locator('textarea[placeholder^="Start writing"]')
  const menuBtn = 'header button[title="Menu"]'
  /** Open the hamburger dropdown and return a locator for it (no-op if already open). */
  async function openMenu() {
    const m = page.locator('[role="menu"]')
    if ((await m.count()) === 0) await page.click(menuBtn)
    return m
  }
  /** Open the hamburger dropdown and click one of its items (closes the menu). */
  async function pickMenuItem(name) {
    const m = await openMenu()
    await m.getByRole('menuitem', { name, exact: true }).click()
  }

  // ---- T1: layout — top bar + full-width editor, no side panels ------------
  check('T1 layout: header with Menu button', (await page.locator(menuBtn).count()) === 1)
  check('T1 layout: exactly one top bar (single header)', (await page.locator('header').count()) === 1)
  check(
    'T1 layout: styling/generation controls hidden until menu opens or doc exists',
    (await page.locator('[role="toolbar"]').count()) === 0 &&
      (await page.locator('select[title="Editor font"]').count()) === 0 &&
      (await page.locator('button[title="Small text"]').count()) === 0,
  )
  check('T1 layout: no side panels (aside)', (await page.locator('aside').count()) === 0)
  check('T1 layout: no focus-mode exit button', (await page.locator('button[title="Exit focus mode (Esc)"]').count()) === 0)
  const footerText = await page.locator('footer').innerText()
  check('T1 statusbar: no save-state indicator', !/saving|saved/i.test(footerText), footerText.slice(0, 80))
  check(
    'T1 state: seeded profile active, empty workspace',
    (await page.locator('select[title="Server profile"]').inputValue()) === 'mock-profile' &&
      (await page.getByText('No story selected.').count()) === 1,
  )
  const modelsLoaded = await page
    .waitForFunction(() => [...document.querySelectorAll('select option')].some((o) => o.value === 'llama3.1-8b-instruct'), { timeout: 10000 })
    .then(() => true)
    .catch(() => false)
  check('T1 models: mock server model list loaded', modelsLoaded)

  // ---- T2: Stories modal — create a story -----------------------------------
  await pickMenuItem('Stories')
  const storiesDlg = () => page.locator('dialog[aria-label="Stories"][open]')
  check('T2 stories: dialog opens', (await storiesDlg().count()) === 1)
  await storiesDlg().locator('button[title="New story"]').click()
  await ta.waitFor()
  check('T2 stories: doc created and modal closed', (await page.locator('dialog[open]').count()) === 0)

  // ---- T2b: single top bar — generation controls + menu text styling ----------
  await page.locator('header button:has-text("Continue")').waitFor({ timeout: 5000 }) // hasDoc re-render
  check(
    'T2b topbar: generation controls visible with a doc',
    (await page.locator('header button:has-text("Continue")').count()) === 1 &&
      (await page.locator('[role="toolbar"]').count()) === 1,
    `continue=${await page.locator('header button:has-text("Continue")').count()} toolbar=${await page.locator('[role="toolbar"]').count()}`,
  )
  check(
    'T2b topbar: selection ops disabled without a selection',
    (await page.locator('button[aria-label="Expand"]').isDisabled()),
  )
  const m2 = await openMenu()
  check(
    'T2b menu: Stories/World moved into the hamburger menu',
    (await m2.getByRole('menuitem', { name: 'Stories', exact: true }).count()) === 1 &&
      (await m2.getByRole('menuitem', { name: 'World', exact: true }).count()) === 1,
  )
  check(
    'T2b menu: text size / line length / font controls present',
    (await m2.getByText('Text size', { exact: true }).count()) === 1 &&
      (await m2.getByText('Line length', { exact: true }).count()) === 1 &&
      (await m2.locator('select[title="Editor font"]').count()) === 1,
  )
  const sizeBefore = await ta.evaluate((el) => getComputedStyle(el).fontSize)
  await m2.getByRole('group', { name: 'Text size' }).getByText('A', { exact: true }).first().click() // small
  const sizeAfter = await ta.evaluate((el) => getComputedStyle(el).fontSize)
  check('T2b styling: text size control changes editor font size', sizeBefore !== sizeAfter, `${sizeBefore} -> ${sizeAfter}`)
  await page.keyboard.press('Escape') // close the menu before moving on

  // Tooltips must open downward (the top bar sits at the window's top edge) and
  // the right-most ones anchor to their left edge so long tips can't run off-screen.
  const tipEls = await page.evaluate(() => {
    const tips = [...document.querySelectorAll('header [data-tip]')]
    return { count: tips.length, allDown: tips.every((t) => t.dataset.tipPos === 'down') }
  })
  check('T2b tooltips: top-bar tips point down', tipEls.count >= 5 && tipEls.allDown, `count=${tipEls.count}`)
  const contTipBtn = page.locator('header button:has-text("Continue")')
  await contTipBtn.hover()
  await page.waitForTimeout(300)
  const tipCss = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('header button')]
    const w = btns.find((b) => b.textContent?.includes('Continue'))?.parentElement
    if (!w) return null
    const cs = getComputedStyle(w, '::after')
    return { top: cs.top, bottom: cs.bottom, right: cs.right }
  })
  check(
    'T2b tooltips: Continue tip renders below, anchored to its left edge',
    !!tipCss && tipCss.top !== 'auto' && tipCss.right === '0px',
    JSON.stringify(tipCss),
  )

  // ---- T2c: reply-length slider (top bar, left of the selection ops) ----------
  // KNOWN-DRIFT (pre-existing, tracked separately): this slider now lives inside the
  // hamburger menu, so the bare top-bar probe below finds nothing. The presence check
  // records the drift as a FAIL; the rest is skipped so the suite reaches later sections
  // instead of crashing on an unguarded boundingBox() timeout.
  const replySlider = page.locator('header input[type="range"][aria-label="Reply length"]')
  const replySliderPresent = (await replySlider.count()) === 1
  check(
    'T2c slider: present with a doc, default ~1 page (2^10 = 1024 tokens)',
    replySliderPresent && (await replySlider.inputValue()) === '10',
  )
  if (!replySliderPresent) {
    step('T2c: slider not in the top bar (moved to the hamburger menu) — skipping remaining T2c checks')
  } else {
    const sliderBox = await replySlider.boundingBox()
    const expandBox = await page.locator('button[aria-label="Expand"]').boundingBox()
    check(
      'T2c slider: positioned to the left of the Expand button',
      !!sliderBox && !!expandBox && sliderBox.x < expandBox.x,
    )
    await replySlider.focus()
    await page.keyboard.press('ArrowLeft') // 1024 -> 512
    await page.waitForTimeout(300)
    check(
      'T2c slider: stepping down updates the human-readable label',
      (await replySlider.inputValue()) === '9' &&
        (await page.locator('header').getByText('(a few paragraphs)', { exact: true }).count()) === 1,
    )
    const replyControl = page.locator('header label', { has: page.locator('input[type="range"][aria-label="Reply length"]') })
    const replySpans = replyControl.locator('span')
    const spanCount = await replySpans.count()
    const spanTexts = []
    for (let i = 0; i < spanCount; i++) spanTexts.push(await replySpans.nth(i).innerText())
    check(
      'T2c slider: shows the token count (512) before the description',
      spanCount === 2 && spanTexts[0] === '512' && spanTexts[1] === '(a few paragraphs)',
      `count=${spanCount} texts=${JSON.stringify(spanTexts)}`,
    )
    await page.keyboard.press('ArrowLeft') // 512 -> 256 ("a paragraph" — a different label width)
    await page.waitForTimeout(300)
    const sliderBoxAfter = await replySlider.boundingBox()
    check(
      'T2c slider: fixed-width label does not shift the slider while dragging',
      !!sliderBox && !!sliderBoxAfter && sliderBox.x === sliderBoxAfter.x && sliderBox.width === sliderBoxAfter.width,
    )
    await page.waitForTimeout(1200) // let the debounced settings save flush
    await page.reload()
    await page.waitForSelector('footer')
    await page.locator('header button:has-text("Continue")').waitFor({ timeout: 5000 })
    check('T2c slider: choice persists after reload', (await replySlider.inputValue()) === '8')
  }

  // ---- T3: Stories modal — inline rename ------------------------------------
  await ta.fill('The lighthouse keeper climbed the spiral stairs as the storm rolled in off the bay.\nShe lit the great lamp and watched the beam sweep the black water.')
  await pickMenuItem('Stories')
  const dlg = storiesDlg()
  await dlg.locator('button[title="Open story (double-click to rename)"]').first().dblclick()
  const renameInput = dlg.locator('input.input-bordered').first()
  check('T3 rename: input appears on double-click', (await renameInput.count()) === 1)
  await renameInput.fill('The Lighthouse Keeper')
  await renameInput.press('Enter')
  check('T3 rename: committed title shown in list', (await dlg.getByText('The Lighthouse Keeper').count()) >= 1)
  // The explicit pencil button reopens inline editing; Escape cancels it without closing the modal.
  await dlg.locator('button[title="Rename story"]').first().click()
  check('T3 rename: pencil button reopens the input', (await renameInput.count()) === 1)
  await renameInput.fill('A Different Title')
  await renameInput.press('Escape')
  check(
    'T3 rename: Escape cancels and keeps the modal open',
    (await dlg.getByText('The Lighthouse Keeper').count()) >= 1 &&
      (await dlg.getByText('A Different Title').count()) === 0 &&
      (await storiesDlg().count()) === 1,
  )
  await dlg.locator('button[title="Close"]').click()

  // ---- T4: World modal — tabs + add a note ------------------------------------
  await pickMenuItem('World')
  const worldDlg = () => page.locator('dialog[aria-label="World notes"][open]')
  check('T4 world: dialog opens', (await worldDlg().count()) === 1)
  // Tone / World notes / Characters are now separate tabs; Tone is the default.
  const toneTab = worldDlg().getByRole('tab', { name: /^Tone$/ })
  const notesTab = worldDlg().getByRole('tab', { name: /World notes/ })
  const charsTab = worldDlg().getByRole('tab', { name: /^Characters$/ })
  check(
    'T4 world: opens with Tone/Notes/Characters tabs, Tone active',
    (await worldDlg().locator('[role="tab"]').count()) === 3 &&
      (await toneTab.getAttribute('aria-selected')) === 'true' &&
      (await worldDlg().locator('textarea[placeholder^="e.g. Third person limited"]').count()) === 1,
  )
  const boxW = await worldDlg().locator('.modal-box').evaluate((el) => el.getBoundingClientRect().width)
  check('T4 world: modal is larger (max-w-3xl)', boxW >= 700, `w=${Math.round(boxW)}`)
  await notesTab.click()
  check(
    'T4 world: World-notes tab shows the note list',
    (await notesTab.getAttribute('aria-selected')) === 'true' &&
      (await worldDlg().locator('button[title="Add world note"]').count()) === 1,
  )
  await worldDlg().locator('button[title="Add world note"]').click()
  // New notes render as daisyUI collapses and start collapsed. The closed state is
  // expressed via content-visibility:hidden on .collapse-content (the box keeps its
  // padding, so a geometry check would read ~8px instead of 0).
  const note = worldDlg().locator('.collapse')
  const cv = () => note.first().locator('.collapse-content').evaluate((el) => getComputedStyle(el).contentVisibility)
  check('T4 world: new note starts collapsed', (await note.count()) === 1 && (await cv()) === 'hidden')
  await note.first().locator('input[type="checkbox"]').check()
  await page.waitForTimeout(400) // grid-rows transition (~200ms) + content-visibility delay
  check('T4 world: expanding reveals the note fields', (await cv()) !== 'hidden')
  await worldDlg().locator('input[placeholder="Title (shown in prompts)"]').first().fill('The Bay')
  await worldDlg().locator('textarea[placeholder^="Details the model should know"]').first().fill('A small harbor where the story begins; storms come from the west.')
  await page.waitForTimeout(200)
  check('T4 world: note listed', (await worldDlg().getByText('The Bay').count()) >= 1)
  check('T4 world: notes tab badge shows the count', (await notesTab.innerText()).includes('1'))
  await charsTab.click()
  check(
    'T4 world: Characters tab shows its empty state + add button',
    (await worldDlg().getByText('No characters yet.').count()) === 1 &&
      (await worldDlg().locator('button[title="Add character"]').count()) === 1,
  )
  await toneTab.click()
  check(
    'T4 world: Tone tab still shows the tone editor',
    (await worldDlg().locator('textarea[placeholder^="e.g. Third person limited"]').count()) === 1,
  )
  await worldDlg().locator('button[title="Close"]').click()

  // ---- T5: Context modal from the status bar ---------------------------------
  await page.click('footer button[title^="Context usage"]')
  const ctxDlg = page.locator('dialog[open]')
  check('T5 context: dialog opens with budget', (await ctxDlg.getByText('Prompt budget').count()) === 1)
  check('T5 context: max context shown', (await ctxDlg.getByText('Max context').count()) === 1)
  await ctxDlg.locator('button[title="Close"]').click()

  // ---- T6: TopBar menu — theme picker + shortcuts ---------------------------
  const rootDiv = page.locator('div[data-theme]')
  const before = await rootDiv.getAttribute('data-theme')
  await page.click(menuBtn)
  const menu = page.locator('[role="menu"]')
  check('T6 menu: opens with items', (await menu.count()) === 1 && (await menu.getByText(/theme/i).count()) >= 1)
  const themeSelect = menu.locator('select[title="DaisyUI theme"]')
  check('T6 theme: picker lists the 7 presets', (await themeSelect.locator('option').count()) === 7)
  const nextTheme = ['abyss', 'dim', 'caramellatte', 'corporate', 'retro', 'silk', 'valentine'].find((t) => t !== before) ?? 'dim'
  await themeSelect.selectOption(nextTheme)
  await page.waitForTimeout(200)
  const after = await rootDiv.getAttribute('data-theme')
  check('T6 theme: picker switches preset', after === nextTheme, `${before} -> ${after}`)
  check('T6 menu: closed after choosing', (await page.locator('[role="menu"]').count()) === 0)
  await page.keyboard.press('F1')
  await page.waitForTimeout(200)
  check('T6 shortcuts: F1 opens shortcuts dialog', (await page.locator('dialog[open]').filter({ hasText: 'Keyboard shortcuts' }).count()) === 1)
  await page.keyboard.press('F1')
  await page.waitForTimeout(200)

  // ---- T6b: About menu item ---------------------------------------------------
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  await page.click(menuBtn)
  await page.waitForTimeout(150)
  check('T6 about: menu shows About item', (await page.locator('[role="menu"] button:has-text("About PairQuill")').count()) === 1)
  await page.click('[role="menu"] button:has-text("About PairQuill")')
  await page.waitForTimeout(200)
  const aboutDlg = page.locator('dialog[open]').filter({ hasText: 'PairQuill' })
  check('T6 about: dialog shows version from package.json', (await aboutDlg.getByText(`Version ${pkg.version}`).count()) === 1)
  check('T6 about: dialog shows license from package.json', (await aboutDlg.getByText(`License: ${pkg.license}`).count()) === 1)
  check('T6 about: GitHub link present', (await aboutDlg.locator('a[href="https://github.com/skhmt/pairquill"]').count()) === 1)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // ---- T7: generation — Continue streams into the editor ---------------------
  const contBtn = page.locator('header button:has-text("Continue")')
  check('T7 gen: continue enabled with doc', !(await contBtn.isDisabled()))
  const lenBefore = (await ta.inputValue()).length
  await contBtn.click()
  const stopVisible = await page
    .waitForSelector('button[title="Stop generation"]', { timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  check('T7 gen: top bar shows Stop while generating', stopVisible)
  const streamed = await page
    .waitForFunction(() => document.querySelector('textarea[placeholder^="Start writing"]').value.includes('The wind picked up'), { timeout: 15000 })
    .then(() => true)
    .catch(() => false)
  check('T7 gen: mock stream appended to editor', streamed && chatHits === 1, `chatHits=${chatHits}`)
  check('T7 gen: text actually grew', (await ta.inputValue()).length > lenBefore)

  // ---- T7b: retry — re-sends the previous request, replacing its output --------
  // Let the continue stream fully settle first (runOp's finally clears `gen`).
  await page.waitForFunction((gen) => document.querySelector('textarea[placeholder^="Start writing"]').value.includes(gen), GENERATED, { timeout: 15000 })
  await page.waitForTimeout(400)
  const retryBtn = page.locator('button[aria-label="Retry"]')
  check('T7b retry: button enabled after a generation', !(await retryBtn.isDisabled()))
  await page.keyboard.press('Control+Shift+y')
  const t0 = Date.now()
  while (chatHits < 2 && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 100))
  check('T7b retry: Ctrl+Shift+Y re-sent the previous request', chatHits === 2, `chatHits=${chatHits}`)
  // The mock always returns the same text: a correct retry replaces the old output
  // in place, so the generated sentence must appear exactly once (not twice).
  await page.waitForTimeout(800)
  const afterRetry = await ta.inputValue()
  const occurrences = afterRetry.split('The wind picked up').length - 1
  check('T7b retry: old output replaced, not duplicated', occurrences === 1, `occurrences=${occurrences}`)

  // ---- T7c: instruct — continue with custom instructions ------------------------
  await page.locator('button[aria-label="Instruct"]').click()
  const instructDlg = page.locator('dialog[aria-label="Instruct continuation"][open]')
  check('T7c instruct: dialog opens without a selection', (await instructDlg.count()) === 1)
  const lenBeforeInstr = (await ta.inputValue()).length
  await instructDlg.locator('textarea').fill('Have the keeper signal the approaching boat.')
  await instructDlg.getByRole('button', { name: 'Continue' }).click()
  await page.waitForTimeout(200)
  check('T7c instruct: dialog closed after apply', (await page.locator('dialog[open]').count()) === 0)
  const instructed = await page
    .waitForFunction((gen) => document.querySelector('textarea[placeholder^="Start writing"]').value.split(gen).length - 1 >= 2, GENERATED, { timeout: 15000 })
    .then(() => true)
    .catch(() => false)
  check('T7c instruct: generation ran and appended at cursor', instructed && chatHits === 3, `chatHits=${chatHits}`)
  check('T7c instruct: text actually grew', (await ta.inputValue()).length > lenBeforeInstr)

  // ---- T7d: content rating — slider guidance flows into every request ----------
  // KNOWN-DRIFT (pre-existing, tracked separately): like T2c, the rating slider moved into
  // the hamburger menu. The presence check records the drift as a FAIL; the rest is skipped
  // so the suite continues instead of crashing on ratingSlider.focus().
  const ratingSlider = page.locator('input[type="range"][aria-label="Content rating"]')
  const ratingSliderPresent = (await ratingSlider.count()) === 1
  check(
    'T7d rating: slider present with 3 stops (0..2), defaulting to SFW',
    ratingSliderPresent &&
      (await ratingSlider.getAttribute('min')) === '0' &&
      (await ratingSlider.getAttribute('max')) === '2' &&
      (await ratingSlider.inputValue()) === '0',
  )
  if (!ratingSliderPresent) {
    step('T7d: rating slider not in the bar (moved to the hamburger menu) — skipping remaining T7d checks')
  } else {
    check(
      'T7d rating: SFW label shown in the bar',
      (await page.locator('header').getByText('SFW', { exact: true }).count()) === 1,
    )
    const windCount = async () => (await ta.inputValue()).split(GENERATED).length - 1
    await page.waitForTimeout(500) // let the last generation's stream fully commit before baselining
    let expectedWind = await windCount() // one mock sentence per generation so far
    const ratingPrompts = []
    for (const [label, phrase] of [
      ['SFW', 'safe for work'],
      ['Romance / Softcore', 'softcore level'],
      ['Explicit / Hardcore', 'Explicit content is permitted'],
    ]) {
      const target = label === 'SFW' ? 0 : label.startsWith('Romance') ? 1 : 2
      await ratingSlider.focus()
      while (Number(await ratingSlider.inputValue()) !== target) {
        await page.keyboard.press(Number(await ratingSlider.inputValue()) < target ? 'ArrowRight' : 'ArrowLeft')
      }
      check(
        `T7d rating: bar label shows "${label}"`,
        (await page.locator('header').getByText(label, { exact: true }).count()) === 1,
      )
      const prevBody = lastChatBody
      await contBtn.click()
      expectedWind++
      // Node-side wait for the new request body to be captured, then page-side wait for
      // the mock sentence to land in the editor; assert on the captured snapshot.
      const deadline = Date.now() + 10_000
      while (lastChatBody === prevBody && Date.now() < deadline) await page.waitForTimeout(50)
      const body = lastChatBody
      const sysPrompt = body?.messages?.[0]?.content ?? ''
      ratingPrompts.push(sysPrompt)
      const settled = await page
        .waitForFunction(
          // Playwright passes `arg` as a single value — destructure the [gen, n] pair.
          ([gen, n]) => document.querySelector('textarea[placeholder^="Start writing"]').value.split(gen).length - 1 >= n,
          [GENERATED, expectedWind],
          { timeout: 10_000 },
        )
        .then(() => true)
        .catch(() => false)
      check(
        `T7d rating: request at "${label}" carries its guidance`,
        body !== prevBody && settled && sysPrompt.includes(`Content rating: ${label}`) && sysPrompt.includes(phrase),
        `newBody=${body !== prevBody} settled=${settled} wind=${await windCount()} hasRatingBlock=${sysPrompt.includes('Content rating:')}`,
      )
    }
    check(
      'T7d rating: system prompt differs for every stop',
      new Set(ratingPrompts).size === 3,
      `unique=${new Set(ratingPrompts).size}`,
    )
  }

  // ---- T8: save current story (.json) + re-import it --------------------------
  const dlPath = path.join(os.tmpdir(), 'pairquill-verify-story.json')
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.click('header button[title="Menu"]')
      await page.locator('[role="menu"]').getByText('Save current story (.json)').click()
    })(),
  ])
  await dl.saveAs(dlPath)
  check('T8 save: filename uses slug + date', /^the-lighthouse-keeper-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename())
  const proj = JSON.parse(fs.readFileSync(dlPath, 'utf8'))
  const pdoc = (proj.docs ?? []).find((d) => d.title === 'The Lighthouse Keeper')
  check(
    'T8 save: single-story project with world data',
    !!pdoc && pdoc.worldNotes?.length === 1 && pdoc.worldNotes[0].title === 'The Bay',
    JSON.stringify(pdoc?.worldNotes ?? null),
  )
  await pickMenuItem('Stories')
  const dlg8 = page.locator('dialog[open]')
  const rowsBefore = await dlg8.locator('li.group').count()
  await dlg8.locator('input[type="file"]').setInputFiles(dlPath)
  await page.waitForTimeout(700)
  check('T8 import: story merged (row added)', (await dlg8.locator('li.group').count()) === rowsBefore + 1, `${rowsBefore} -> ${await dlg8.locator('li.group').count()}`)
  check('T8 import: toast reported', (await page.getByText(/Imported 1 story/).count()) >= 1)
  await dlg8.locator('button[title="Close"]').click()
  await pickMenuItem('World')
  const worldDlg8 = page.locator('dialog[open]')
  await worldDlg8.getByRole('tab', { name: /World notes/ }).click() // notes are on their own tab now
  check('T8 import: world data restored on active story', (await worldDlg8.getByText('The Bay').count()) >= 1)
  await worldDlg8.locator('button[title="Close"]').click()

  // ---- T9: Stories modal — delete with styled confirm -------------------------
  await pickMenuItem('Stories')
  const dlg9 = storiesDlg()
  const rowsBeforeDel = await dlg9.locator('li.group').count()
  let row = dlg9.locator('li.group').first()
  await row.hover()
  await row.locator('button[title="Delete story"]').click()
  const confirmDlg = () => page.locator('dialog[aria-label="Confirm"][open]')
  check('T9 delete: styled confirm dialog appears', (await confirmDlg().count()) === 1)
  check('T9 delete: message names the story', (await confirmDlg().getByText('The Lighthouse Keeper').count()) >= 1)
  await confirmDlg().getByRole('button', { name: 'Cancel' }).click()
  check('T9 delete: cancel keeps the story', (await dlg9.locator('li.group').count()) === rowsBeforeDel)
  row = dlg9.locator('li.group').first()
  await row.hover()
  await row.locator('button[title="Delete story"]').click()
  await confirmDlg().getByRole('button', { name: 'Delete' }).click()
  await page.waitForTimeout(300)
  check('T9 delete: confirm removes the story', (await dlg9.locator('li.group').count()) === rowsBeforeDel - 1)
  await dlg9.locator('button[title="Close"]').click()

  // ---- T10: editor — no scroll jump while typing ------------------------------
  const longText = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: The beam cut through rain and salt, and the keeper kept her watch.`).join('\n\n')
  await ta.fill(longText)
  await page.waitForTimeout(200)
  // The writing textarea auto-sizes; the scroll container is its outer overflow-y-auto
  // ancestor (no stable class), so find it by walking up from the textarea and mark it
  // (page.evaluate cannot return DOM elements, so we locate it again via an attribute).
  await page.evaluate(() => {
    let el = document.querySelector('textarea[placeholder^="Start writing"]')
    while (el && el !== document.body) {
      const cs = getComputedStyle(el)
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        el.setAttribute('data-verify-scroller', '1')
        return
      }
      el = el.parentElement
    }
    throw new Error('no scrollable ancestor for the editor textarea')
  })
  const scroller = page.locator('[data-verify-scroller="1"]')
  await scroller.evaluate((el) => {
    const ta2 = el.querySelector('textarea')
    ta2.focus()
    ta2.setSelectionRange(600, 600)
    el.scrollTop = 300
  })
  const stBefore = await scroller.evaluate((el) => el.scrollTop)
  await page.keyboard.type('x', { delay: 15 })
  await page.waitForTimeout(250)
  const stAfter = await scroller.evaluate((el) => el.scrollTop)
  check('T10 editor: typing does not jump the scroll position', Math.abs(stAfter - stBefore) <= 3, `${stBefore} -> ${stAfter}`)

  // ---- T11: Servers & models — API-key link follows the selected preset --------
  await page.locator('footer button[title="Server & model settings"]').click()
  const dlg11 = page.locator('dialog[open]')
  check(
    'T11 server modal: opens with the seeded profile',
    (await dlg11.getByText('Servers & models').count()) === 1,
  )
  // Two-pane layout: wider box, and the profile list lives on the left of the editor.
  const sBoxW = await dlg11.locator('.modal-box').evaluate((el) => el.getBoundingClientRect().width)
  check('T11 server modal: wider two-pane layout (max-w-4xl)', sBoxW >= 850, `w=${Math.round(sBoxW)}`)
  const listX = await dlg11.locator('[data-server-list]').evaluate((el) => el.getBoundingClientRect().x)
  const editorX = await dlg11.locator('[data-profile-editor]').evaluate((el) => el.getBoundingClientRect().x)
  check(
    'T11 server modal: profile list sits to the left of the editor',
    (await dlg11.locator('[data-server-list] .fa-circle-dot').count()) === 1 && listX < editorX,
    `list.x=${Math.round(listX)} editor.x=${Math.round(editorX)}`,
  )
  // Refresh must actually fetch and report back inline (run while the seeded mock profile is active)
  const refreshBtn = dlg11.locator('label[data-model-combo] button[title="Refresh model list only"]')
  const hitsBefore = modelsHits
  await refreshBtn.click()
  const noteAppeared = await page
    .waitForFunction(() => !!document.querySelector('label[data-model-combo] .text-success'), { timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  check(
    'T11 server modal: refresh button fetches the model list',
    modelsHits === hitsBefore + 1,
    `hits ${hitsBefore} -> ${modelsHits}`,
  )
  const noteText = noteAppeared ? await dlg11.locator('label[data-model-combo] .text-success').innerText() : ''
  check(
    'T11 server modal: refresh shows an inline success note',
    /model/.test(noteText),
    JSON.stringify(noteText),
  )
  // The list opens upward over the fields above the input; the refresh button sits in the
  // input row itself, so the topmost element at its center must still be the button
  const modelInput2 = dlg11.locator('input[placeholder="pick or type a model id"]')
  await modelInput2.click()
  await page.waitForTimeout(300)
  const topAtBtn = await refreshBtn.evaluate((b) => {
    const r = b.getBoundingClientRect()
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return b.contains(el) ? 'button' : (el ? el.tagName : 'none')
  })
  check(
    'T11 server modal: refresh stays clickable while the model list is open',
    topAtBtn === 'button',
    `topmost=${topAtBtn}`,
  )
  await page.keyboard.press('Escape') // closes only the list…
  check(
    'T11 server modal: Escape closes the model list but keeps the dialog open',
    (await dlg11.getByText('Servers & models').count()) === 1,
  )
  const presetSel = dlg11.locator('select[data-server-preset]')
  const keyLink = dlg11.locator('label:has-text("API key") a')
  check(
    'T11 server modal: no API-key link for a custom base URL',
    (await presetSel.inputValue()) === '' && (await keyLink.count()) === 0,
    `preset=${JSON.stringify(await presetSel.inputValue())}`,
  )
  await presetSel.selectOption({ label: 'OpenRouter' })
  check(
    'T11 server modal: link appears next to "API key" for a preset with an api page',
    (await keyLink.count()) === 1 && (await keyLink.innerText()).includes('get a key'),
  )
  const linkAttrs = await keyLink.evaluate((a) => ({
    href: a.getAttribute('href'),
    target: a.getAttribute('target'),
    rel: a.getAttribute('rel'),
  }))
  check(
    'T11 server modal: link points at the preset api page, opens in a new window',
    linkAttrs.href === 'https://openrouter.ai/workspaces/default/keys' &&
      linkAttrs.target === '_blank' &&
      (linkAttrs.rel ?? '').includes('noopener'),
    JSON.stringify(linkAttrs),
  )
  await presetSel.selectOption({ label: 'LM Studio' })
  check(
    'T11 server modal: link hidden again for a local preset without an api page',
    (await keyLink.count()) === 0,
  )
  const urlInput = dlg11.locator('input[placeholder="http://127.0.0.1:8888"]')
  const modelInput = dlg11.locator('input[placeholder="pick or type a model id"]')
  check(
    'T11 server modal: preset selection filled the URL and model boxes',
    (await urlInput.inputValue()) === 'http://localhost:3000' && (await modelInput.inputValue()) !== '',
    `url=${JSON.stringify(await urlInput.inputValue())} model=${JSON.stringify(await modelInput.inputValue())}`,
  )
  await presetSel.selectOption({ label: 'Custom…' })
  check(
    'T11 server modal: "Custom…" clears the URL and model boxes',
    (await urlInput.inputValue()) === '' && (await modelInput.inputValue()) === '',
    `url=${JSON.stringify(await urlInput.inputValue())} model=${JSON.stringify(await modelInput.inputValue())}`,
  )
  check(
    'T11 server modal: "Custom…" hides the API-key link',
    (await keyLink.count()) === 0,
  )
  check(
    'T11 server modal: single refresh button in the model input row',
    (await dlg11.locator('button[title="Refresh model list only"]').count()) === 1 &&
      (await refreshBtn.count()) === 1,
  )
  // --- cursor + overlap regressions for the refresh button living in the input row ---
  const cursor11 = await refreshBtn.evaluate((b) => getComputedStyle(b).cursor)
  check('T11 server modal: refresh button shows a pointer cursor', cursor11 === 'pointer', `cursor=${cursor11}`)
  const inBox11 = await modelInput.boundingBox()
  let btnBox11 = await refreshBtn.boundingBox()
  check(
    'T11 server modal: input and refresh button sit side by side (no overlap)',
    !!inBox11 &&
      !!btnBox11 &&
      (btnBox11.x >= inBox11.x + inBox11.width - 0.5 || inBox11.x >= btnBox11.x + btnBox11.width - 0.5),
    `in=${JSON.stringify(inBox11)} btn=${JSON.stringify(btnBox11)}`,
  )
  // The combobox opens on the input's focus event. The earlier list-open/Escape left this
  // input focused (selectOption does not move focus), and clicking an already-focused input
  // fires no focus event — blur it first so every "open" click below really opens the list.
  const unfocusModelInput = () =>
    page.evaluate(() => {
      const a = document.activeElement
      if (a instanceof HTMLInputElement && a.placeholder === 'pick or type a model id') a.blur()
    })
  const dirOf11 = async () => {
    const cls = await dlg11
      .locator('label[data-model-combo] .absolute')
      .first()
      .getAttribute('class')
      .catch(() => null)
    return cls?.includes('bottom-full') ? 'up' : cls?.includes('top-full') ? 'down' : '?'
  }
  const btnClearOfList11 = async () => {
    const lb = await dlg11.locator('label[data-model-combo] ul').boundingBox().catch(() => null)
    if (!lb || !btnBox11) return true
    return !(
      btnBox11.x < lb.x + lb.width &&
      btnBox11.x + btnBox11.width > lb.x &&
      btnBox11.y < lb.y + lb.height &&
      btnBox11.y + btnBox11.height > lb.y
    )
  }
  const topIsBtn11 = () =>
    refreshBtn
      .evaluate((b) => {
        const r = b.getBoundingClientRect()
        return b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
      })
      .catch(() => false)
  // Guard against a vacuous pass: the overlap assertions only mean something if the list rendered.
  const listOpen11 = () => dlg11.locator('label[data-model-combo] ul li').count().then((n) => n > 0)
  await unfocusModelInput()
  await modelInput.click() // opens in whichever direction has room
  await page.waitForTimeout(300)
  const dir1 = await dirOf11()
  check(
    `T11 server modal: list opened ${dir1} does not cover the refresh button`,
    (await listOpen11()) && (await btnClearOfList11()) && (await topIsBtn11()),
  )
  await page.keyboard.press('Escape') // closes only the list
  // fitDropdown measures room inside the modal box, so viewport height alone never flips the
  // direction; phone width (<768) is what forces dropUp=false. Use whichever yields the opposite.
  if (dir1 === 'up') await page.setViewportSize({ width: 390, height: 844 })
  else await page.setViewportSize({ width: 1280, height: 720 })
  await page.waitForTimeout(300)
  btnBox11 = await refreshBtn.boundingBox() // modal re-centers on resize — recapture
  await unfocusModelInput()
  await modelInput.click() // refits with the new viewport
  await page.waitForTimeout(300)
  // On phone width fitDropdown also nudges the box scroll so the list has room below the
  // input — that moves the button between the pre-open capture and the open state, so the
  // overlap check must compare against the button's final (post-open) position.
  btnBox11 = await refreshBtn.boundingBox()
  const dir2 = await dirOf11()
  check(
    `T11 server modal: list opened ${dir2} does not cover the refresh button`,
    (await listOpen11()) && (await btnClearOfList11()) && (await topIsBtn11()),
  )
  await page.keyboard.press('Escape') // closes only the list; dialog stays open
  await page.keyboard.press('Escape') // close the dialog

  // ---- summary -----------------------------------------------------------------
  check('no page errors during run', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
  const failed = results.filter((r) => !r.ok)
  step(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`)
  if (failed.length) failed.forEach((f) => step('FAILED: ' + f.name))
  await browser.close()
  srv.close()
  clearTimeout(hardStop)
  process.exit(failed.length ? 1 : 0)
} catch (err) {
  step('ERROR: ' + (err?.stack ?? String(err)))
  process.exit(2)
}

