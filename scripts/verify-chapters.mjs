// End-to-end verification for Chapter Support (docs/chapters-plan.md §13):
// 1. Legacy non-chaptered doc unchanged (no outline, no view segment, full doc tail)
// 2. Chaptering flow (Add chapters, split at cursor, rename, move up/down, delete)
// 3. Persistence across reload
// 4. Generation in Chapter mode (only active chapter sent as story tail)
// 5. Summaries (manual & AI summarize, ContextModal toggle + budget line, prompt injection)
// 6. Full-story view (read-only, separators, disabled Continue, outline navigation, lossless switch back)
// 7. Project v2 export / v1 backward-compatible import + helper invariants

import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const results = []
const pageErrors = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

const PORT = 9879
const GENERATED = ' Continuation text from mock.'
const MOCK_SUMMARY = 'A concise summary of the chapter events.'
let lastChatBody = null
let nextReply = GENERATED

const srv = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.end()
    return
  }
  if ((req.url ?? '').includes('/models')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'mock-model', context_length: 32768, loaded: true }] }))
    return
  }
  if ((req.url ?? '').includes('/chat/completions')) {
    const bodyParts = []
    req.on('data', (c) => bodyParts.push(c))
    req.on('end', () => {
      try {
        lastChatBody = JSON.parse(Buffer.concat(bodyParts).toString('utf8'))
      } catch {
        lastChatBody = null
      }
      const reply = nextReply
      res.setHeader('Content-Type', 'text/event-stream')
      const chunks = reply.match(/.{1,12}/gs) ?? [reply]
      let i = 0
      const t = setInterval(() => {
        if (i < chunks.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`)
        } else {
          clearInterval(t)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 20, completion_tokens: reply.length } })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }, 15)
    })
    return
  }
  res.statusCode = 404
  res.end('{}')
}).listen(PORT, '127.0.0.1')

const hardStop = setTimeout(() => {
  console.error('GLOBAL TIMEOUT')
  process.exit(3)
}, 90_000)

try {
  const browser = await chromium.launch({ channel: 'msedge' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror', (e) => {
    pageErrors.push(e.message)
    console.error('[pageerror]', e.message)
  })

  await page.goto('file:///' + path.join(root, 'dist', 'index.html').replace(/\\/g, '/'))
  await page.waitForSelector('footer')
  await page.waitForTimeout(800)

  // Seed a clean legacy non-chaptered story + mock profile
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
    tx.objectStore('documents').put({
      id: 'legacy-doc',
      title: 'Legacy Tale',
      content: 'First paragraph of the tale.\n\nSecond paragraph of the tale.',
      createdAt: 1000,
      updatedAt: 1000,
      worldNotes: [],
      characters: [],
      tone: '',
      contextOverride: null,
    })
    tx.objectStore('profiles').put({
      id: 'mock-profile',
      name: 'Mock',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: '',
      modelId: 'mock-model',
      systemPromptTemplate: '',
      params: { temperature: 0.8, topP: 1, maxTokens: 0, stopSequences: [] },
    })
    tx.objectStore('settings').put(
      {
        theme: 'abyss',
        activeProfileId: 'mock-profile',
        activeDocId: 'legacy-doc',
        fontSize: 'md',
        measure: 'normal',
        fontFamily: 'serif',
        replyLength: 1024,
        rating: 0,
      },
      'app',
    )
    await new Promise((res, rej) => {
      tx.oncomplete = res
      tx.onerror = () => rej(tx.error)
    })
    db.close()
  }, PORT)

  await page.reload()
  await page.waitForSelector('textarea[placeholder^="Start writing"]')
  await page.waitForTimeout(400)

  const ta = page.locator('textarea[placeholder^="Start writing"]')

  // ---- 1. Legacy unchanged --------------------------------------------------
  check(
    '1. Legacy doc: no outline sidebar and no view-mode segment',
    (await page.locator('aside[aria-label="Chapters outline"]').count()) === 0 &&
      (await page.locator('[role="group"][aria-label="View mode"]').count()) === 0,
  )
  nextReply = GENERATED
  lastChatBody = null
  await page.click('header button:has-text("Continue")')
  await page.waitForFunction(() => !document.querySelector('header button[title="Stop generation"]'))
  await page.waitForTimeout(200)
  const legacyUserMsg = lastChatBody?.messages?.[1]?.content ?? ''
  check(
    '1. Legacy doc: Continue sends full doc content',
    legacyUserMsg.includes('First paragraph of the tale.') &&
      legacyUserMsg.includes('Second paragraph of the tale.'),
  )

  // Restore clean text for chapter 1
  await ta.fill('Part One text.')
  await page.waitForTimeout(200)

  // ---- 2. Chaptering flow ---------------------------------------------------
  await page.click('header button[title="Menu"]')
  await page.locator('[role="menu"]').getByRole('menuitem', { name: 'Enable chapters', exact: true }).click()
  await page.locator('aside[aria-label="Chapters outline"]').waitFor()
  check(
    '2. Enable chapters: outline opens with 1 chapter containing full text',
    (await page.locator('aside[aria-label="Chapters outline"] li').count()) === 1 &&
      (await ta.inputValue()) === 'Part One text.',
  )
  // Verify outline resize handle & click-to-minimize edge divider (and no TopBar toggle button)
  check(
    '2. TopBar: no outline toggle button',
    (await page.locator('header button[title^="Chapters"]').count()) === 0,
  )
  const aside = page.locator('aside[aria-label="Chapters outline"]')
  const handle = page.locator('[role="separator"][aria-label="Resize or toggle chapters outline"]')
  const wBefore = (await aside.boundingBox()).width
  const hBox = await handle.boundingBox()
  await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(hBox.x + hBox.width / 2 + 60, hBox.y + hBox.height / 2)
  await page.mouse.up()
  const wAfter = (await aside.boundingBox()).width
  check('2. Outline resize: dragging separator resizes outline', wAfter > wBefore + 40, `${wBefore} -> ${wAfter}`)

  // Click the edge divider -> minimizes outline to 0px while keeping divider visible
  await handle.click()
  await page.waitForTimeout(250)
  const wMin = (await aside.boundingBox()).width
  const dividerVisible = await handle.isVisible()
  check('2. Outline minimize: clicking edge divider minimizes to 0px, divider stays visible', wMin === 0 && dividerVisible, `wMin=${wMin}`)
  // Click again -> expands back
  await handle.click()
  await page.waitForTimeout(250)
  const wRestored = (await aside.boundingBox()).width
  check('2. Outline restore: clicking edge divider restores outline', wRestored > 200, `wRestored=${wRestored}`)

  // Verify chapter controls are horizontally centered in TopBar
  const headerBox = await page.locator('header').boundingBox()
  const ctrlBox = await page.locator('header [data-chapter-controls]').boundingBox()
  const headerCenter = headerBox.x + headerBox.width / 2
  const ctrlCenter = ctrlBox.x + ctrlBox.width / 2
  check(
    '2. TopBar: chapter controls are centered horizontally',
    Math.abs(headerCenter - ctrlCenter) < 100,
    `headerCenter=${Math.round(headerCenter)}, ctrlCenter=${Math.round(ctrlCenter)}`,
  )
  check(
    '2. Outline footer: Split at cursor, bottom Summarize, and Remove chapters removed from outline',
    (await page.locator('aside button:has-text("Split at cursor")').count()) === 0 &&
      (await page.locator('aside button:has-text("Summarize")').count()) === 0 &&
      (await page.locator('aside button:has-text("Remove chapters")').count()) === 0,
  )

  // Add chapter 2 via "+ New"
  await page.click('aside button[title="New chapter"]')
  await page.waitForTimeout(150)
  await ta.fill('Part Two text.')
  await page.waitForTimeout(200)
  const itemsAfterAdd = await page.locator('aside[aria-label="Chapters outline"] li').count()
  const ch2Val = await ta.inputValue()
  const ch2OutlineText = await page.locator('aside[aria-label="Chapters outline"] li').nth(1).innerText()
  check(
    '2. New chapter: 2 chapters, new chapter defaults to "Chapter 2"',
    itemsAfterAdd === 2 && ch2Val === 'Part Two text.' && ch2OutlineText.includes('Chapter 2'),
    `count=${itemsAfterAdd}, ch2=${JSON.stringify(ch2Val)}`,
  )

  // Click first chapter to verify first half
  await page.locator('aside[aria-label="Chapters outline"] li').nth(0).locator('button').first().click()
  await page.waitForTimeout(300)
  const ch1Val = await ta.inputValue()
  check('2. Split at cursor: first chapter has first half', ch1Val === 'Part One text.', JSON.stringify(ch1Val))

  // Rename chapter 1 via dblclick + Enter
  await page.locator('aside[aria-label="Chapters outline"] li').nth(0).locator('button').first().dblclick()
  const renameInput = page.locator('aside[aria-label="Chapters outline"] input')
  await renameInput.fill('Opening')
  await renameInput.press('Enter')
  await page.waitForTimeout(150)
  check(
    '2. Rename chapter: inline rename updates title',
    (await page.locator('aside[aria-label="Chapters outline"] li').nth(0).innerText()).includes('Opening'),
  )

  // Verify up/down move buttons are removed and drag-to-reorder works
  check(
    '2. Outline actions: up/down move buttons removed',
    (await page.locator('aside[aria-label="Chapters outline"] button[title="Move up"]').count()) === 0 &&
      (await page.locator('aside[aria-label="Chapters outline"] button[title="Move down"]').count()) === 0,
  )
  const row0 = page.locator('aside[aria-label="Chapters outline"] li').nth(0)
  const row1 = page.locator('aside[aria-label="Chapters outline"] li').nth(1)
  await row0.dragTo(row1)
  await page.waitForTimeout(150)
  check(
    '2. Drag reorder: dragging chapter 1 onto chapter 2 moves Opening to position 2',
    (await page.locator('aside[aria-label="Chapters outline"] li').nth(1).innerText()).includes('Opening'),
  )

  // Add a 3rd chapter ("+ New") and type in it
  await page.click('aside button[title="New chapter"]')
  await page.waitForTimeout(150)
  await ta.fill('Part Three text.')
  await page.waitForTimeout(200)
  check(
    '2. Add chapter: 3 chapters total',
    (await page.locator('aside[aria-label="Chapters outline"] li').count()) === 3,
  )

  // ---- 3. Persistence across reload -----------------------------------------
  await page.waitForTimeout(1100) // allow debounced IDB save
  await page.reload()
  await page.waitForSelector('aside[aria-label="Chapters outline"]')
  await page.waitForTimeout(300)
  check(
    '3. Persistence: 3 chapters restored after reload',
    (await page.locator('aside[aria-label="Chapters outline"] li').count()) === 3 &&
      (await ta.inputValue()) === 'Part Three text.',
  )

  // ---- 4. Generation in Chapter mode (chapter 2 of 3) -----------------------
  // Select chapter 2 ("Opening", which has "Part One text.")
  await page.locator('aside[aria-label="Chapters outline"] li').nth(1).locator('button').first().click()
  await page.waitForTimeout(300)
  lastChatBody = null
  nextReply = ' More in ch2.'
  await page.click('header button:has-text("Continue")')
  await page.waitForFunction(() => !document.querySelector('header button[title="Stop generation"]'))
  await page.waitForTimeout(200)
  const ch2UserMsg = lastChatBody?.messages?.[1]?.content ?? ''
  check(
    '4. Chapter-mode Continue: sends only active chapter text, not others',
    ch2UserMsg.includes('Part One text.') &&
      !ch2UserMsg.includes('Part Two text.') &&
      !ch2UserMsg.includes('Part Three text.'),
  )

  // ---- 5. Summaries & ContextModal ------------------------------------------
  nextReply = MOCK_SUMMARY
  // Select chapter 1 (index 0) -> summary is automatically shown; verify no redundant Summary button
  check(
    '5. Outline actions: redundant Summary button removed',
    (await page.locator('aside[aria-label="Chapters outline"] button[title="Summary"]').count()) === 0,
  )
  await page.locator('aside[aria-label="Chapters outline"] li').nth(0).locator('button').first().click()
  await page.waitForTimeout(150)
  await page.locator('aside[aria-label="Chapters outline"] li').nth(0).locator('button:has-text("Auto")').click()
  await page.waitForFunction(() => !document.querySelector('header button[title="Stop generation"]'))
  await page.waitForTimeout(200)
  const ch1SummaryVal = await page.locator('aside[aria-label="Chapters outline"] li').nth(0).locator('textarea').inputValue()
  check('5. Auto-summarize: stores mock summary on chapter 1', ch1SummaryVal === MOCK_SUMMARY, JSON.stringify(ch1SummaryVal))

  // Click chapter 2 near its bottom-right area -> switches to chapter 2
  const ch2Row = page.locator('aside[aria-label="Chapters outline"] li').nth(1).locator('> div').first()
  const ch2Box = await ch2Row.boundingBox()
  await page.mouse.click(ch2Box.x + ch2Box.width - 10, ch2Box.y + ch2Box.height - 2)
  await page.waitForTimeout(150)
  check(
    '5. Click-to-show summary: only clicked chapter summary is shown',
    (await page.locator('aside[aria-label="Chapters outline"] li').nth(0).locator('textarea').count()) === 0 &&
      (await page.locator('aside[aria-label="Chapters outline"] li').nth(1).locator('textarea').count()) === 1,
  )

  // Edit chapter 1 content -> stale caution icon appears on chapter 1 and can be dismissed
  await page.locator('aside[aria-label="Chapters outline"] li').nth(0).locator('button').first().click()
  await page.waitForTimeout(300)
  await ta.fill('Part Two edited after auto-summary.')
  await page.waitForTimeout(150)
  const cautionIcon = page.locator('aside[aria-label="Chapters outline"] li').nth(0).locator('[role="button"][title*="stale"]')
  check('5. Stale summary: caution icon appears when chapter edited after auto-summary', (await cautionIcon.count()) === 1)
  await cautionIcon.click()
  await page.waitForTimeout(150)
  check(
    '5. Stale summary: caution icon can be dismissed',
    (await page.locator('aside[aria-label="Chapters outline"] li').nth(0).locator('[title*="stale"]').count()) === 0,
  )
  // Restore chapter 1 content for later checks
  await ta.fill('Part Two text.')
  await page.waitForTimeout(150)
  // Switch back to chapter 2 ("Opening") so Continue tests ch. 1 summary injection
  await page.locator('aside[aria-label="Chapters outline"] li').nth(1).locator('button').first().click()
  await page.waitForTimeout(300)

  // Open ContextModal and enable "Include summaries of other chapters"
  await page.click('footer button[title*="Context usage"]')
  await page.waitForSelector('dialog[open]')
  const summaryCheckbox = page.locator('dialog[open] input[type="checkbox"]')
  await summaryCheckbox.check()
  await page.waitForTimeout(200)
  const modalText = await page.locator('dialog[open]').innerText()
  check(
    '5. ContextModal: shows Summaries (other chapters) token line item',
    modalText.includes('Summaries (other chapters)'),
  )
  await page.click('dialog[open] button:has-text("Close")')

  // Continue in chapter 2 -> system prompt should include ch. 1 summary, omit ch. 3 (no summary) & ch. 2 (current)
  lastChatBody = null
  nextReply = ' Next.'
  await page.click('header button:has-text("Continue")')
  await page.waitForFunction(() => !document.querySelector('header button[title="Stop generation"]'))
  await page.waitForTimeout(200)
  const sysPrompt = lastChatBody?.messages?.[0]?.content ?? ''
  check(
    '5. Summaries in prompt: includes ch. 1 summary and omits ch. 2 & unsummarized ch. 3',
    sysPrompt.includes('Story so far — other chapters (summarized):') &&
      sysPrompt.includes('Ch. 1 ·') &&
      sysPrompt.includes(MOCK_SUMMARY) &&
      sysPrompt.includes('You are currently writing inside "Ch. 2 · Opening"') &&
      !sysPrompt.includes('Ch. 2 · Opening:') &&
      !sysPrompt.includes('Ch. 3 ·'),
  )

  // ---- 6. Full-story view (editable + inline header rename) -----------------
  await page.locator('[role="group"][aria-label="View mode"] button:has-text("Full story")').click()
  await page.waitForTimeout(200)
  const storyTas = page.locator('textarea[placeholder^="Start writing"]')
  const storyTitles = page.locator('input[aria-label$=" title"]')
  const continueEnabled = !(await page.locator('header button:has-text("Continue")').isDisabled())
  const headerValues = []
  const titleCount = await storyTitles.count()
  for (let i = 0; i < titleCount; i++) headerValues.push(await storyTitles.nth(i).inputValue())
  check(
    '6. Full-story view: editable textareas, Continue enabled, headers without "Ch. #"',
    (await storyTas.count()) === 3 &&
      continueEnabled &&
      headerValues.every((v) => !/^Ch\.\s*\d+/i.test(v)),
    `tas=${await storyTas.count()}, headers=${JSON.stringify(headerValues)}`,
  )
  // Inline rename chapter 1 header in Full-story view
  await storyTitles.nth(0).fill('Prologue')
  await storyTitles.nth(0).blur()
  await page.waitForTimeout(150)
  check(
    '6. Full-story view: inline header rename updates outline',
    (await page.locator('aside[aria-label="Chapters outline"] li').nth(0).innerText()).includes('Prologue'),
  )
  // Edit chapter 3 in Full-story view and run Continue on it
  await storyTas.nth(2).focus()
  await storyTas.nth(2).fill('Part Three edited.')
  nextReply = ' Streamed in full-story.'
  await page.click('header button:has-text("Continue")')
  await page.waitForFunction(() => !document.querySelector('header button[title="Stop generation"]'))
  await page.waitForTimeout(200)
  const ch3AfterGen = await storyTas.nth(2).inputValue()
  check(
    '6. Full-story view: Continue streams into focused chapter',
    ch3AfterGen.includes('Part Three edited.') && ch3AfterGen.includes('Streamed in full-story.'),
  )
  // Switch back to Chapter mode -> edits preserved
  await page.locator('[role="group"][aria-label="View mode"] button:has-text("Chapter")').click()
  await page.waitForTimeout(200)
  check(
    '6. Full-story view: switching back to Chapter mode preserves edits',
    (await ta.inputValue()) === ch3AfterGen,
  )

  // Delete chapter 3 -> confirm dialog -> falls back to 2 chapters
  await page.locator('aside[aria-label="Chapters outline"] li').nth(2).locator('button[title="Delete chapter"]').click()
  await page.locator('dialog[aria-label="Confirm"][open] button:has-text("Delete")').click()
  await page.waitForTimeout(200)
  check(
    '2. Delete chapter: confirm dialog removes chapter',
    (await page.locator('aside[aria-label="Chapters outline"] li').count()) === 2,
  )

  // ---- 7. Project v2 export -------------------------------------------------
  // Verify "Disable chapters" is in the hamburger menu
  await page.click('header button[title="Menu"]')
  check(
    '7. Menu: Disable chapters item present for chaptered doc',
    (await page.locator('[role="menu"]').getByRole('menuitem', { name: 'Disable chapters', exact: true }).count()) === 1,
  )
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[role="menu"]').getByRole('menuitem', { name: 'Save all stories (.json)', exact: true }).click(),
  ])
  const dlPath = await download.path()
  const exported = JSON.parse(fs.readFileSync(dlPath, 'utf8'))
  check(
    '7. Project v2 export: version 2 and chapters array preserved',
    exported.version === 2 &&
      Array.isArray(exported.docs[0].chapters) &&
      exported.docs[0].chapters.length === 2 &&
      exported.docs[0].chapters[0].summary === MOCK_SUMMARY,
  )

  // Verify .txt export includes chapter headers in the proper areas
  await page.click('header button[title="Menu"]')
  const [txtDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[role="menu"]').getByRole('menuitem', { name: 'Export current story (.txt)', exact: true }).click(),
  ])
  const txtPath = await txtDownload.path()
  const txtExported = fs.readFileSync(txtPath, 'utf8')
  check(
    '7. TXT export: includes chapter headers before each chapter',
    txtExported.includes('Prologue\n\n') && txtExported.includes('Opening\n\nPart One text.'),
    JSON.stringify(txtExported.slice(0, 120)),
  )

  check('No uncaught pageerrors', pageErrors.length === 0, pageErrors.join('; '))
  await browser.close()
} finally {
  clearTimeout(hardStop)
  srv.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
