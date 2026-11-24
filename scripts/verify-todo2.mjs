// Browser verification of the six todo2.md fixes, run in Edge via playwright-core:
//   1. Model dropdown stays open on row clicks / scrolling (incl. scrollbar drag),
//      closes on outside pointerdown, keyboard nav (ArrowUp/Down, Enter, Esc) works.
//   2. Context display updates when the selected model changes (from model metadata).
//   3. Large model list caps at 50 rows with a "keep typing" footer; each row shows context length;
//      the open list never forces an outer scrollbar on the modal box.
//   4. Long API errors: toast wraps inside its box, is dismissible, ~1000-char slice works.
//   5. Model selection persists across restarts; missing model falls back to a preferred
//      (loaded) model with an info toast.
//   6. Generated-text underline stays aligned through edits / font changes / scrolling
//      (checked against an INDEPENDENT hidden-mirror probe), and long documents do not
//      create phantom vertical scroll inside the textarea.
// Logs every step to verify-todo2-steps.log. Exits non-zero on any failure.
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const logFile = path.join(root, 'verify-todo2-steps.log')
fs.writeFileSync(logFile, '')
const step = (m) => { console.log(m); fs.appendFileSync(logFile, m + '\n') }
const results = []
const pageErrors = []
const check = (name, ok, extra = '') => { results.push({ name, ok }); step(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`) }

// ---------------------------------------------------------------- mock server
const PORT = 9878
let models = [
  { id: 'story-llama-70b', context_length: 131072, loaded: true }, // preferred → auto-selected when saved model is missing/empty
  { id: 'tiny-model-1b', context_length: 8192, loaded: true },     // fallback target for the missing-model test
  { id: 'fail-model', context_length: 4096 },                      // returns HTTP 500 with a long error body
]
for (let i = 3; i < 80; i++) models.push({ id: `filler-model-${String(i).padStart(2, '0')}`, context_length: 32768 })

// Long enough that llm.ts's slice(0, 1000) truncates it before the sentinel.
let ERR_MSG =
  'Model backend failed: CUDA out of memory while allocating activation tensors for layer 47/80. ' +
  'Tried to allocate 23.98 GiB; GPU 0 has a total capacity of 24.00 GiB of which only 1.20 GiB is free. ' +
  'Including non-PyTorch memory, this process has 22.50 GiB in use. Of the allocated memory 20.11 GiB is ' +
  'allocated by PyTorch and 1.87 GiB is reserved but unallocated.'
while (ERR_MSG.length < 1300) ERR_MSG += ' Additional diagnostics: the caching allocator reported fragmentation across 14 segments; consider reducing batch size or enabling expandable_segments before retrying.'
const SENTINEL = 'TRUNCATION_SENTINEL_TAIL'
ERR_MSG += ' ' + SENTINEL

const GENERATED =
  ' The wind picked up along the pier, and every lantern swung in unison.\n\nA fisherman on the jetty pulled his coat tighter against the cold, watching the light arc across black water until it found the boat he had been waiting all night for.'

// Every real API request path the app sends — used to verify /v1 auto-append.
const apiPaths = []
const srv = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', '*'); res.end(); return }
  if (req.method === 'POST' && (req.url ?? '').includes('/__set_models')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try { models = JSON.parse(body).models } catch { /* ignore */ }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true }))
    })
    return
  }
  if ((req.url ?? '').includes('/models')) {
    apiPaths.push(req.url ?? '')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: models }))
    return
  }
  if ((req.url ?? '').includes('/chat/completions')) {
    apiPaths.push(req.url ?? '')
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let modelId = ''
      try { modelId = JSON.parse(body).model } catch { /* ignore */ }
      if (modelId === 'fail-model') {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: { message: ERR_MSG } }))
        return
      }
      res.setHeader('Content-Type', 'text/event-stream')
      const chunks = GENERATED.match(/.{1,14}/gs) ?? []
      let i = 0
      const t = setInterval(() => {
        if (i < chunks.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`)
        } else {
          clearInterval(t)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: GENERATED.length } })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }, 12)
    })
    return
  }
  res.statusCode = 404; res.end('{}')
}).listen(PORT, '127.0.0.1')

// ------------------------------------------------------------------- helpers
const hardStop = setTimeout(() => { step('GLOBAL TIMEOUT'); process.exit(3) }, 150_000)
let browser
try {
  browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (e) => { pageErrors.push(e.message); step('[pageerror] ' + e.message) })

  const ta = page.locator('textarea[placeholder^="Start writing"]')
  const modelSelect = page.locator('footer select[title^="Model"]')
  const ctxBtn = page.locator('footer button[title^="Context usage"]')
  const toast = () => page.locator('[role="status"]')

  /** Footer context-window readout (e.g. "131,072"). */
  async function ctxShown() { return await ctxBtn.innerText() }

  /** Independent underline probe: re-lays-out the generated range in a hidden mirror
   *  built from the textarea's live computed styles + Range.getClientRects(), then
   *  compares against the rendered .gen-new bars. Tolerance 2px. */
  async function compareBars(start, end) {
    const r = await page.evaluate(([s, e]) => {
      const t = document.querySelector('textarea[placeholder^="Start writing"]')
      if (!t) return { error: 'no textarea' }
      const cs = getComputedStyle(t)
      const padL = parseFloat(cs.paddingLeft), padT = parseFloat(cs.paddingTop), padR = parseFloat(cs.paddingRight)
      const width = Math.max(10, t.clientWidth - padL - padR)
      const lineH = parseFloat(cs.lineHeight) || 0
      const probe = document.createElement('div')
      probe.style.cssText =
        `position:absolute;top:0;left:-9999px;visibility:hidden;margin:0;padding:0;border:0;` +
        `white-space:pre-wrap;overflow-wrap:break-word;width:${width}px;` +
        `font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};font-style:${cs.fontStyle};` +
        `line-height:${cs.lineHeight};letter-spacing:${cs.letterSpacing}`
      document.body.appendChild(probe)
      const sM = document.createElement('span'), eM = document.createElement('span')
      probe.append(document.createTextNode(t.value.slice(0, s)), sM, document.createTextNode(t.value.slice(s, e)), eM)
      const range = document.createRange()
      range.setStart(sM, 0); range.setEnd(eM, 0)
      const mRect = probe.getBoundingClientRect()
      const taRect = t.getBoundingClientRect()
      const expected = Array.from(range.getClientRects()).filter((rc) => rc.width > 0.5).map((rc) => ({
        left: taRect.left + Math.max(0, rc.left - mRect.left) + padL,
        top: taRect.top + Math.max(0, rc.top - mRect.top) + padT + (rc.height >= 4 ? rc.height : lineH) - 2,
        width: rc.width,
      }))
      probe.remove()
      const actual = Array.from(document.querySelectorAll('.gen-new')).map((el) => {
        const b = el.getBoundingClientRect()
        return { left: b.left, top: b.top, width: b.width }
      })
      return { expected, actual }
    }, [start, end])
    if (r.error) return { ok: false, detail: r.error }
    if (r.expected.length !== r.actual.length) {
      return { ok: false, detail: `bar count ${r.actual.length} != expected ${r.expected.length}` }
    }
    let worst = 0
    for (let i = 0; i < r.expected.length; i++) {
      const dx = Math.abs(r.expected[i].left - r.actual[i].left)
      const dy = Math.abs(r.expected[i].top - r.actual[i].top)
      const dw = Math.abs(r.expected[i].width - r.actual[i].width)
      worst = Math.max(worst, dx, dy, dw)
    }
    return { ok: worst <= 2, detail: `${r.actual.length} bars, max offset ${worst.toFixed(2)}px` }
  }

  // ---- boot: wipe IndexedDB, seed one profile with an EMPTY saved model --------
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
      id: 'mock-profile', name: 'Mock', baseUrl: `http://127.0.0.1:${port}`, apiKey: '', // no /v1 → app must append it
      modelId: '', // empty → startup refresh must auto-select the preferred (loaded) model
      systemPromptTemplate: '',
      params: { temperature: 0.8, topP: 1, maxTokens: 0, stopSequences: [] },
    })
    tx.objectStore('settings').put(
      { theme: 'dark', activeProfileId: 'mock-profile', activeDocId: null, fontSize: 'md', measure: 'normal', fontFamily: 'serif' },
      'app',
    )
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
    db.close()
  }, PORT)
  await page.reload()
  await page.waitForSelector('footer')

  // ---- B: startup model refresh auto-selects the preferred loaded model --------
  await page.waitForFunction(
    () => document.querySelector('select[title^="Model"]')?.value === 'story-llama-70b',
    undefined, { timeout: 15_000 },
  )
  check('B1 startup: empty saved model auto-selected to preferred (loaded) story-llama-70b', true)
  const ctxBoot = await ctxShown()
  check('B2 context display shows selected model metadata (131,072)', ctxBoot.includes('131,072'), ctxBoot.replace(/\n/g, ' | '))

  // ---- new story -----------------------------------------------------------------
  await page.getByRole('button', { name: 'New story' }).click()
  await ta.waitFor()

  // ---- D: model dropdown in the server modal -------------------------------------
  await page.click('footer button[title="Server & model settings"]')
  const dlg = page.locator('dialog').filter({ hasText: 'Servers & models' })
  await dlg.waitFor()
  const dlgIsOpen = () => dlg.evaluate((el) => el.open).catch(() => false)
  const comboInput = dlg.locator('[data-model-combo] input')
  const rows = () => dlg.locator('[data-model-combo] ul li button')

  // D12: Base URL field shows a trailing "/v1" suffix inside its input wrapper
  // (daisyUI "label for input at the end" pattern)
  const v1Suffix = await dlg.locator('.modal-box').evaluate((el) =>
    Array.from(el.querySelectorAll('.input')).some(
      (w) => w.querySelector('input') && (w.textContent ?? '').trim().endsWith('/v1'),
    ),
  )
  check('D12 Base URL input shows trailing "/v1" suffix', v1Suffix)

  await dlg.locator('button[title="Refresh model list only"]').click()
  await page.waitForFunction(() => document.querySelectorAll('select[title^="Model"] option').length >= 80)

  // D1: large list caps at 50 rows with a "keep typing" footer
  await comboInput.click()
  await page.waitForTimeout(150)
  check('D1a dropdown opens on input focus', (await rows().count()) > 0)
  check('D1b large list capped at 50 rows', (await rows().count()) === 50, `rows=${await rows().count()}`)
  const capCount = await dlg.locator('[data-model-combo] div').evaluateAll((els) => els.filter((el) => (el.textContent ?? '').trim().startsWith('Showing first')).length)
  check('D1c "Showing first 50 of 80 — keep typing" footer visible', capCount === 1, `matching divs=${capCount}`)

  // D2: each row shows its context length
  const rowText = async (id) => rows().filter({ hasText: id }).first().innerText()
  check('D2a row badge: story-llama-70b → 131k', (await rowText('story-llama-70b')).includes('131k'))
  check('D2b row badge: tiny-model-1b → 8k', (await rowText('tiny-model-1b')).includes('8k'))
  check('D2c row badge: filler-model-05 → 33k', (await rowText('filler-model-05')).includes('33k'))

  // D3: wheel-scrolling the list keeps the dropdown open
  const ul = dlg.locator('[data-model-combo] ul')
  const box = await ul.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + 40)
  const stBefore = await ul.evaluate((el) => el.scrollTop)
  await page.mouse.wheel(0, 400)
  await page.waitForTimeout(150)
  const stAfter = await ul.evaluate((el) => el.scrollTop)
  check('D3a wheel scroll actually scrolled the list', stAfter > stBefore, `scrollTop ${stBefore} → ${stAfter}`)
  check('D3b dropdown still open after wheel scroll', (await rows().count()) === 50)

  // D4: dragging near the scrollbar edge (pointerdown inside the combo) keeps it open
  await page.mouse.move(box.x + box.width - 4, box.y + 30)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width - 4, box.y + 30 + i * 12)
  await page.mouse.up()
  await page.waitForTimeout(150)
  check('D4 dropdown still open after scrollbar-edge drag', (await rows().count()) === 50)

  // D11: opening the large list must not give .modal-box its own scrollbar — that outer
  // scrollbar used to appear, and a click on it is an "outside" pointerdown that closed
  // the dropdown, making the bottom of long lists unreachable.
  const fit = await dlg.locator('.modal-box').evaluate((el) => {
    const box = el.getBoundingClientRect()
    const drop = el.querySelector('[data-model-combo] div.absolute')?.getBoundingClientRect()
    return {
      outerOverflow: el.scrollHeight - el.clientHeight,
      fits: !!drop && drop.bottom <= box.bottom + 1 && drop.top >= box.top - 1,
    }
  })
  check('D11a no outer scrollbar on the modal while the large list is open', fit.outerOverflow <= 1, `scrollHeight-clientHeight=${fit.outerOverflow}`)
  check('D11b dropdown fits fully inside the modal box', fit.fits)

  // D5: outside pointerdown closes the dropdown
  await dlg.locator('h4', { hasText: 'Editing:' }).click()
  await page.waitForTimeout(120)
  check('D5 dropdown closes on outside pointerdown', (await rows().count()) === 0)

  // D6: keyboard navigation — type to filter, ArrowDown highlights, Enter selects
  await comboInput.click()
  // The input displays profile.modelId — select-all first so the typed filter replaces it.
  await page.keyboard.press('Control+a')
  await page.keyboard.type('tiny')
  await page.waitForTimeout(120)
  check('D6a filter narrows to 1 row', (await rows().count()) === 1, `rows=${await rows().count()}`)
  await page.keyboard.press('ArrowDown')
  const activeRow = dlg.locator('[data-model-combo] ul li button[data-active]')
  check('D6b ArrowDown highlights the row', (await activeRow.count()) === 1 && (await activeRow.first().getAttribute('title')) === 'tiny-model-1b')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  check('D6c Enter selects tiny-model-1b and closes dropdown',
    (await comboInput.inputValue()) === 'tiny-model-1b' && (await rows().count()) === 0)
  // maxContext falls back to a conservative 8,192 for unknown ids, so also require the
  // footer select to prove the selection actually committed.
  check('B3 model select + context display update to tiny-model-1b (8,192)',
    (await modelSelect.inputValue()) === 'tiny-model-1b' && (await ctxShown()).includes('8,192'),
    `select=${await modelSelect.inputValue()} ctx=${(await ctxShown()).replace(/\n/g, ' | ')}`)

  // D7: clicking a row selects it and closes the dropdown (the original regression)
  await dlg.locator('h4', { hasText: 'Editing:' }).click() // blur the input first
  await comboInput.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('story-llama')
  await page.waitForTimeout(120)
  await rows().first().click()
  await page.waitForTimeout(150)
  check('D7a row click selects story-llama-70b', (await comboInput.inputValue()) === 'story-llama-70b')
  check('D7b dropdown closed after row click', (await rows().count()) === 0)
  check('B4 context display updates back to 131,072', (await ctxShown()).includes('131,072'))

  // D8: Escape closes the dropdown — and, because the app opens with showModal(), it also
  // natively closes the whole modal (documented behavior in ServerModal.svelte).
  await comboInput.click()
  await page.waitForTimeout(100)
  check('D8a dropdown reopens on focus', (await rows().count()) > 0)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  check('D8b Escape closes the dropdown and the modal (native showModal behavior)', !(await dlgIsOpen()))

  // D9: the footer's native select changes the model directly (modal already closed by D8,
  // so no backdrop can swallow Playwright's interaction)
  await modelSelect.selectOption('fail-model')
  check('D9a footer select switches model (ctx → 4,096)', (await ctxShown()).includes('4,096'), (await ctxShown()).replace(/\n/g, ' | '))
  await modelSelect.selectOption('story-llama-70b')
  check('D9b restore story-llama-70b (ctx → 131,072)', (await ctxShown()).includes('131,072'), (await ctxShown()).replace(/\n/g, ' | '))

  // D10: the modal can be reopened; footer now offers "New" (not "Done") — close via X
  await page.click('footer button[title="Server & model settings"]')
  await page.waitForTimeout(250)
  check('D10a modal reopens', await dlgIsOpen())

  // ---- N: footer "New" replaces "Done"; preset dropdown pre-populates the base URL --
  const presetSel = dlg.locator('select[data-server-preset]')
  const urlInput = dlg.locator('label:has-text("Base URL") .input input')
  const nameInput = dlg.locator('label:has-text("Name") input')
  check(
    'N1a footer has a New button and no Done',
    (await dlg.locator('.modal-action button[title="Create a new profile"]').count()) === 1 &&
      (await dlg.locator('.modal-action').getByRole('button', { name: 'Done' }).count()) === 0,
  )
  const presetOptCount = await presetSel.locator('option').count()
  check(
    'N1b preset dropdown lists the 8 endpoints + Custom',
    presetOptCount === 9,
    `options=${presetOptCount}`,
  )

  // seeded mock URL is not a preset -> select shows "Custom…"
  check('N2a non-preset URL shown as Custom', (await presetSel.inputValue()) === '')
  // picking a preset pre-populates the base URL and name inputs
  await presetSel.selectOption({ label: 'LM Studio' })
  check(
    'N2b selecting LM Studio pre-fills URL + name',
    (await urlInput.inputValue()) === 'http://localhost:3000' &&
      (await presetSel.inputValue()) === 'http://localhost:3000' &&
      (await nameInput.inputValue()) === 'LM Studio',
  )
  // manual entry still works and drops the select back to "Custom…"
  await urlInput.fill(`http://127.0.0.1:${PORT}`)
  check(
    'N2c manual URL keeps working; select falls back to Custom',
    (await urlInput.inputValue()) === `http://127.0.0.1:${PORT}` &&
      (await presetSel.inputValue()) === '',
  )
  // restore the seeded name so later sections (e.g. the F1 fallback toast) see "Mock"
  await nameInput.fill('Mock')

  // N3: "New" adds a profile to the edit box
  await dlg.locator('.modal-action button[title="Create a new profile"]').click()
  check(
    'N3a New creates a new profile in the edit box',
    (await dlg.locator('h4', { hasText: 'Editing: Server 2' }).count()) === 1,
    `header=${await dlg.locator('h4').first().innerText()}`,
  )
  // re-select the seeded profile so the remaining sections run against it
  await dlg.locator('.max-h-48 > div', { hasText: 'Mock' }).click()
  await page.waitForTimeout(300)
  check(
    'N3b re-selecting Mock restores it as active',
    (await modelSelect.inputValue()) === 'story-llama-70b',
  )

  await dlg.locator('button[title="Close (Esc)"]').click()
  await page.waitForTimeout(250)
  check('D10b X button closes the modal', !(await dlgIsOpen()))

  // ---- U: generation + underline alignment ---------------------------------------
  const BASE = 'The lighthouse keeper climbed the spiral stairs as the storm rolled in off the bay.'
  await ta.fill(BASE)
  await ta.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length) })
  await page.click('header .btn-primary:has-text("Continue")')
  await page.waitForFunction(
    (tail) => document.querySelector('textarea[placeholder^="Start writing"]').value.endsWith(tail),
    'all night for.', { timeout: 20_000 },
  )
  await page.waitForSelector('button[title="Stop generation"]', { state: 'detached' })
  await page.waitForSelector('.gen-new')
  const genStart = BASE.length
  const genEnd = await ta.evaluate((el) => el.value.length)

  const u1 = await compareBars(genStart, genEnd)
  check('U1 underline aligned right after generation (independent probe)', u1.ok, u1.detail)

  // U2: alignment holds after scrolling the editor
  await page.evaluate(() => {
    const t = document.querySelector('textarea[placeholder^="Start writing"]')
    let el = t.parentElement
    while (el && getComputedStyle(el).overflowY !== 'auto') el = el.parentElement
    if (el) el.scrollTop = Math.max(1, Math.floor((el.scrollHeight - el.clientHeight) / 2))
  })
  await page.waitForTimeout(200)
  const u2 = await compareBars(genStart, genEnd)
  check('U2 underline still aligned after scrolling', u2.ok, u2.detail)

  // U3: alignment holds after a font-size change (mirror re-projection)
  await page.click('header button[title="Menu"]')
  await page.click('button[title="Large text"]')
  await page.waitForTimeout(450)
  const u3 = await compareBars(genStart, genEnd)
  check('U3 underline still aligned after font-size change to Large', u3.ok, u3.detail)
  await page.click('button[title="Medium text"]')
  await page.waitForTimeout(300)

  // U4: a manual edit clears the highlight cleanly (no stale bars)
  await ta.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length) })
  await page.keyboard.type(' The gulls scattered.')
  await page.waitForTimeout(350)
  check('U4 manual edit clears generated-text highlight (no stale bars)', (await page.locator('.gen-new').count()) === 0)

  // ---- E: long API error toast -----------------------------------------------------
  await modelSelect.selectOption('fail-model')
  await page.waitForTimeout(1200) // let the debounced profile save land
  await ta.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length) })
  await page.click('header .btn-primary:has-text("Continue")')
  await toast().waitFor({ state: 'visible' })
  const errText = await toast().innerText()
  check('E1a error toast shows the HTTP error text', errText.includes('CUDA out of memory'))
  check('E1b long error is truncated (~1000 char slice, sentinel cut off)',
    !errText.includes(SENTINEL) && errText.length >= 1000, `toast length=${errText.length}`)
  const toastBox = await toast().boundingBox()
  const tScroll = await toast().evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
  check('E2 long error wraps inside the toast box (no horizontal overflow)',
    !!toastBox && toastBox.height >= 40 && tScroll.sw <= tScroll.cw + 1,
    `h=${toastBox ? Math.round(toastBox.height) : '?'}px scrollWidth=${tScroll.sw} clientWidth=${tScroll.cw}`)
  await toast().locator('button[title="Dismiss"]').click()
  await page.waitForTimeout(200)
  check('E3 error toast dismissible', (await toast().count()) === 0)

  // ---- P: selection persists across restarts ---------------------------------------
  await modelSelect.selectOption('filler-model-10')
  await page.waitForTimeout(1500) // debounced save (800ms) + margin
  await page.reload()
  await page.waitForSelector('footer')
  await page.waitForFunction(
    () => document.querySelector('select[title^="Model"]')?.value === 'filler-model-10',
    undefined, { timeout: 15_000 },
  )
  check('P1 model selection survives a restart (filler-model-10 kept)', true)
  check('P2 context display reflects the persisted model (32,768)', (await ctxShown()).includes('32,768'))

  // ---- F: missing saved model → fallback to preferred + info toast ------------------
  await fetch(`http://127.0.0.1:${PORT}/__set_models`, {
    method: 'POST',
    body: JSON.stringify({ models: [
      { id: 'tiny-model-1b', context_length: 8192, loaded: true },
      { id: 'fail-model', context_length: 4096 },
    ] }),
  })
  await page.click('footer button[title="Refresh model list"]')
  await toast().waitFor({ state: 'visible' })
  const fbText = await toast().innerText()
  check('F1 info toast explains the fallback', fbText.includes('no longer available') && fbText.includes('switched to tiny-model-1b'), fbText.slice(0, 120))
  check('F2 model select now shows the preferred loaded model', (await modelSelect.inputValue()) === 'tiny-model-1b')
  check('B5 context display updates after fallback (8,192)', (await ctxShown()).includes('8,192'))
  await toast().locator('button[title="Dismiss"]').click()
  await page.waitForTimeout(150)

  // ---- L: long document — no phantom vertical scroll --------------------------------
  const longText = Array.from({ length: 48 }, (_, i) =>
    `Paragraph ${i + 1}: the lighthouse keeper climbed the spiral stairs as the storm rolled in off the bay, counting each step until the lantern room swallowed him in glass and light.`,
  ).join('\n\n')
  await ta.fill(longText)
  await page.waitForTimeout(700)
  const long = await page.evaluate(() => {
    const t = document.querySelector('textarea[placeholder^="Start writing"]')
    let el = t.parentElement
    while (el && getComputedStyle(el).overflowY !== 'auto') el = el.parentElement
    return {
      taOverflow: getComputedStyle(t).overflowY,
      taScrollH: t.scrollHeight, taClientH: t.clientHeight,
      scrollerScrollH: el ? el.scrollHeight : 0, scrollerClientH: el ? el.clientHeight : 0,
    }
  })
  check('L1a textarea overflow-y is hidden (no internal scrollbar)', long.taOverflow === 'hidden')
  check('L1b no phantom scroll inside the textarea', long.taScrollH <= long.taClientH + 1,
    `scrollHeight=${long.taScrollH} clientHeight=${long.taClientH}`)
  check('L1c outer container scrolls instead', long.scrollerScrollH > long.scrollerClientH,
    `scroller scrollHeight=${long.scrollerScrollH} clientHeight=${long.scrollerClientH}`)

  // L2: generate at the end of the long doc — the new-text highlight must reach the
  // text's end (≥3 line bars, no trailing gap below the last bar).
  await ta.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length) })
  await page.click('header .btn-primary:has-text("Continue")')
  await page.waitForFunction(
    (tail) => document.querySelector('textarea[placeholder^="Start writing"]').value.endsWith(tail),
    'all night for.', { timeout: 20_000 },
  )
  await page.waitForSelector('button[title="Stop generation"]', { state: 'detached' })
  await page.waitForSelector('.gen-new')
  await page.waitForTimeout(250) // let fitEditor + highlight re-projection settle
  const barsNow = await page.locator('.gen-new').count()
  const lastGap = await page.evaluate(() => {
    const t = document.querySelector('textarea[placeholder^="Start writing"]')
    const bars = document.querySelectorAll('.gen-new')
    if (!bars.length) return null
    return t.getBoundingClientRect().bottom - bars[bars.length - 1].getBoundingClientRect().bottom
  })
  check('L2 generated-text highlight on a long doc reaches the text end (≥3 line bars, no trailing gap)',
    barsNow >= 3 && lastGap !== null && lastGap < 20, `bars=${barsNow} last-bar→text-bottom gap=${lastGap === null ? 'n/a' : Math.round(lastGap) + 'px'}`)

  // ---- V: base URLs without /v1 are auto-appended at request time -------------------
  const modelPaths = apiPaths.filter((p) => p.includes('/models'))
  const chatPaths = apiPaths.filter((p) => p.includes('chat/completions'))
  check('V1 every model-list request hit the /v1 prefix (seeded URL had no /v1)',
    modelPaths.length > 0 && modelPaths.every((p) => p.startsWith('/v1/models')),
    JSON.stringify(modelPaths.slice(0, 3)))
  check('V2 every chat-completion request hit the /v1 prefix',
    chatPaths.length > 0 && chatPaths.every((p) => p.startsWith('/v1/chat/completions')),
    JSON.stringify(chatPaths.slice(0, 3)))

  // ---- summary ----------------------------------------------------------------------
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join('; ').slice(0, 200))
  const failed = results.filter((r) => !r.ok)
  step(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) { step('FAILED: ' + failed.map((f) => f.name).join(' | ')); process.exitCode = 1 }
  else step('ALL CHECKS PASSED')
  await browser.close()
} catch (e) {
  step('PROBE ERROR: ' + (e.stack || e.message))
  process.exitCode = 2
} finally {
  clearTimeout(hardStop)
  // Always tear the browser down — otherwise a hung probe keeps Edge + keep-alive
  // sockets alive forever and the next run fights it for port 9878.
  await browser?.close().catch(() => {})
  srv.closeAllConnections?.()
  srv.close()
}
