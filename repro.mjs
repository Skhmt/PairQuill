// Throwaway repro for the context-override bug. Run: node repro.mjs
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const log = (m) => { const s = `[${new Date().toISOString()}] ${m}\n`; appendFileSync('repro-trace.log', s); console.log(m) }
process.on('uncaughtException', (e) => { log('UNCAUGHT: ' + (e?.stack || e)); process.exit(1) })
process.on('unhandledRejection', (e) => { log('UNHANDLED: ' + (e?.stack || e)); process.exit(1) })
log('start')

const PORT = 48731
let chatBodies = []
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.writeHead(204)
    res.end()
    return
  }
  if (req.url?.includes('chat/completions')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      chatBodies.push(body)
      writeFileSync('repro-chat-body.json', body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n`)
      res.write(`data: [DONE]\n\n`)
      res.end()
    })
    return
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(
    JSON.stringify({
      data: [{ id: 'llama3', object: 'model', created: 0, owned_by: 'mock', context_length: 131072 }],
    }),
  )
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const browser = await chromium.launch({ channel: 'msedge' })
log('browser launched')
const page = await browser.newPage()
page.setDefaultTimeout(8000)
log('new page')
page.on('console', (m) => { if (m.type() === 'error') log('[console.error] ' + m.text()) })
page.on('pageerror', (e) => log('[pageerror] ' + e.message))

// Dump every .tabular-nums span with its ancestor chain + visibility, plus key page markers.
async function dump(label) {
  const info = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.tabular-nums')].map((el) => {
      let anc = []
      let p = el.parentElement
      while (p && anc.length < 4) { anc.unshift(p.tagName + (p.className ? '.' + String(p.className).split(' ').slice(0, 2).join('.') : '')); p = p.parentElement }
      const r = el.getBoundingClientRect()
      return { text: el.textContent, visible: r.width > 0 && r.height > 0, ancestors: anc.join(' < ') }
    })
    const footer = document.querySelector('footer')
    const dlgOpen = [...document.querySelectorAll('dialog')].filter((d) => d.open).map((d) => d.getAttribute('aria-label') || 'unnamed')
    return {
      spans,
      footerText: footer ? footer.innerText.replace(/\n/g, ' | ') : null,
      openDialogs: dlgOpen,
      noStory: document.body.innerText.includes('No story selected'),
      loading: document.body.innerText.includes('Loading\u2026'),
    }
  })
  log(`--- ${label} ---`)
  for (const s of info.spans) log(`  span "${s.text}" visible=${s.visible} :: ${s.ancestors}`)
  log(`  footer: ${info.footerText}`)
  log(`  openDialogs=${JSON.stringify(info.openDialogs)} noStory=${info.noStory} loading=${info.loading}`)
  return info
}
log('goto...')
await page.goto('file:///C:/Users/Mike/Desktop/PairQuill/dist/index.html')
log('first load done')
// Seed IndexedDB now that the app has opened the DB, then reload so it picks the data up.
await page.evaluate((port) => {
  return new Promise((resolve, reject) => {
    const db = indexedDB.open('pairquill', 1)
    db.onupgradeneeded = () => {
      const d = db.result
      if (!d.objectStoreNames.contains('documents')) d.createObjectStore('documents', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('profiles')) d.createObjectStore('profiles', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings')
    }
    db.onerror = () => reject(db.error)
    db.onsuccess = () => {
      const t = db.result.transaction(['documents', 'profiles'], 'readwrite')
      t.objectStore('profiles').put({
        id: 'p1', name: 'Mock', baseUrl: `http://127.0.0.1:${port}`, apiKey: '', modelId: 'llama3',
        systemPromptTemplate: 'You are a fiction writing assistant.',
        params: { temperature: 0.8, topP: 1, maxTokens: 512, stopSequences: [] }, createdAt: Date.now(), updatedAt: Date.now(),
      })
      t.objectStore('documents').put({
        id: 'd1', title: 'Repro', content: 'Once upon a time there was a lighthouse keeper.',
        worldNotes: [], characters: [], tone: '', contextOverride: null, createdAt: Date.now(), updatedAt: Date.now(),
      })
      t.oncomplete = () => { resolve() }
      t.onerror = () => reject(t.error)
    }
  })
}, PORT)
log('seeded (contextOverride=null, model context_length=131072, maxTokens=512)')
await page.reload()
await page.waitForTimeout(2000)
log('reloaded')

try {
  // 1. No override: status bar should show the MODEL's context length (131,072), not 8,192.
  await dump('STEP1 initial (no override, model ctx=131072)')

  // 2. Open Context modal: input should be empty, placeholder "auto: 131,072".
  await page.locator('button[title^="Context usage"]').first().click()
  await page.waitForTimeout(400)
  const input = page.locator('dialog:visible input[type="number"]')
  log('STEP2 modal open: input="' + (await input.inputValue()) + '" placeholder="' + (await input.getAttribute('placeholder')) + '"')
  await dump('STEP2 modal open')

  // 3. Set override to 65536 via the modal, commit with Enter, close.
  await input.fill('65536')
  await input.press('Enter')
  await page.waitForTimeout(300)
  log('STEP3 after fill+Enter: input="' + (await input.inputValue()) + '"')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await dump('STEP3 closed modal, override should be 65536')

  // 4. Reload: override must persist and still be displayed.
  await page.reload()
  await page.waitForTimeout(2000)
  await dump('STEP4 after reload (override 65536 persisted?)')

  // 4b. Grow the doc to ~300k chars so context trimming becomes observable in the request:
  // under the 65536 override the story tail must be trimmed (~260k fits); with the model's
  // 131072 it would fit untrimmed. Proves the LLM path uses the same effective context as the UI.
  const SENT = 'The lighthouse keeper walked along the coast each morning. '
  const BIG = SENT.repeat(5800) + 'And then the light went out. [ENDMARK]'
  await page.evaluate((content) => {
    return new Promise((resolve, reject) => {
      const db = indexedDB.open('pairquill', 1)
      db.onerror = () => reject(db.error)
      db.onsuccess = () => {
        const t = db.result.transaction(['documents'], 'readwrite')
        const store = t.objectStore('documents')
        const req = store.get('d1')
        req.onsuccess = () => {
          const d = req.result || { id: 'd1', title: 'Repro' }
          d.content = content
          d.updatedAt = Date.now()
          store.put(d)
        }
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error)
      }
    })
  }, BIG)
  log('STEP4b doc grown to ' + BIG.length + ' chars')
  await page.reload()
  await page.waitForTimeout(2000)

  // 5. Trigger a generation (Ctrl+Enter = continue from cursor) and capture the request.
  await page.locator('textarea').first().click()
  await page.keyboard.press('Control+End') // caret at doc end so the full story is in scope
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(2500)
  const toast = await page.evaluate(() => document.querySelector('div.fixed.bottom-10')?.textContent ?? null)
  log('STEP5 toast=' + JSON.stringify(toast) + ' chat bodies received: ' + chatBodies.length)
  if (chatBodies.length) {
    const b = JSON.parse(chatBodies[chatBodies.length - 1])
    log('STEP5 request max_tokens=' + b.max_tokens + ' messages=' + b.messages.length)
    const userMsg = String(b.messages[1]?.content ?? '')
    log('STEP5 user msg len=' + userMsg.length + ' (doc=' + BIG.length + ', trimmed=' + (userMsg.length < BIG.length) + ')')
    log('STEP5 tail reaches doc end: ' + userMsg.includes('[ENDMARK]'))
  } else {
    await dump('STEP5 no request fired')
  }

  // 6. Override LARGER than the model's context length (200k > 131,072): warn-but-allow —
  // the override must still win as the effective value, with an amber warning in the
  // status bar and an explicit warning line in the Context modal.
  await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const db = indexedDB.open('pairquill', 1)
      db.onerror = () => reject(db.error)
      db.onsuccess = () => {
        const t = db.result.transaction(['documents'], 'readwrite')
        const store = t.objectStore('documents')
        const req = store.get('d1')
        req.onsuccess = () => {
          const d = req.result || { id: 'd1', title: 'Repro' }
          d.contextOverride = 200000
          d.updatedAt = Date.now()
          store.put(d)
        }
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error)
      }
    })
  })
  await page.reload()
  await page.waitForTimeout(2000)
  const warnIcon = await page.locator('footer i.fa-triangle-exclamation').count()
  log('STEP6 status bar warning icon count=' + warnIcon + ' (expect 1)')
  const footerText = await page.evaluate(() => document.querySelector('footer')?.innerText ?? '')
  log('STEP6 effective max still honors override (200,000): ' + /200,000/.test(footerText))
  await page.locator('button[title^="Context usage"]').first().click()
  await page.waitForTimeout(400)
  const dlgText = await page.evaluate(() => document.querySelector('dialog[open]')?.innerText ?? '')
  log('STEP6 modal warning shown: ' + /exceeds the model's reported context length \(131,072\)/.test(dlgText))
  await dump('STEP6 override (200k) > model ctx (131072): warn but allow')

  // 7. Reply-length slider (top bar, left of Expand): drop it from the default 1024 to 256
  // and regenerate — the request must carry max_tokens=256 (the profile's own cap is 512,
  // so below it the slider decides; STEP5 above showed 512 with the default slider).
  await page.keyboard.press('Escape') // close the Context modal left open by STEP6
  await page.waitForTimeout(400)
  const slider = page.locator('header input[type="range"][aria-label="Reply length"]')
  log('STEP7 slider present: ' + ((await slider.count()) === 1) + ' value=' + (await slider.inputValue()))
  await slider.focus()
  await page.keyboard.press('ArrowLeft') // 2^10=1024 -> 2^9=512
  await page.keyboard.press('ArrowLeft') // 2^9=512 -> 2^8=256
  await page.waitForTimeout(300)
  log('STEP7 slider value after two ArrowLeft: ' + (await slider.inputValue()) + ' (expect "8" = 2^8 = 256 tokens)')
  const bodiesBefore = chatBodies.length
  await page.locator('textarea').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(2500)
  if (chatBodies.length > bodiesBefore) {
    const b7 = JSON.parse(chatBodies[chatBodies.length - 1])
    log('STEP7 request max_tokens=' + b7.max_tokens + ' (expect 256; profile cap is 512)')
  } else {
    log('STEP7 no request fired')
  }

} catch (e) {
  log('REPRO ERROR: ' + e.message)
}

await browser.close()
server.close()
log('done')
process.exit(0)

