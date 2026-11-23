<script lang="ts">
import type { EditorCommand, GenStats, GenerationRecord, OpKind, ServerProfile, StoryDoc } from '../lib/types'
import { uid, wordCount } from '../lib/format'
import { estimateTokens } from '../lib/tokens'
import { chatStream } from '../lib/llm'
import { OP_LABELS, buildContinueRequest, buildInstructRequest, buildOpRequest, toMessages } from '../lib/prompts'
import type { BuiltRequest } from '../lib/prompts'

let {
  doc,
  profile,
  command,
  maxContext,
  fontSize,
  measure,
  fontFamily,
  onRetryAvailable,
  onCommandDone,
  onGeneration,
  onGenStats,
  onSelectionChange,
  onError,
}: {
  doc: StoryDoc
  profile: ServerProfile | null
  command: EditorCommand | null
  maxContext: number
  fontSize: 'sm' | 'md' | 'lg'
  measure: 'narrow' | 'normal' | 'wide'
  fontFamily: 'serif' | 'sans' | 'mono'
  /** Reports whether this doc has a generation Retry can re-send (top bar button state). */
  onRetryAvailable: (has: boolean) => void
  onCommandDone: () => void
  onGeneration: (g: GenerationRecord) => void
  onGenStats: (s: GenStats) => void
  onSelectionChange: (info: { has: boolean; words: number }) => void
  onError: (msg: string) => void
} = $props()

const fontClass = $derived(fontSize === 'sm' ? 'text-[15px]' : fontSize === 'lg' ? 'text-lg' : 'text-base')
const familyClass = $derived(fontFamily === 'sans' ? 'editor-sans' : fontFamily === 'mono' ? 'editor-mono' : 'editor-serif')
const measureClass = $derived(measure === 'narrow' ? 'max-w-2xl' : measure === 'wide' ? 'max-w-5xl' : 'max-w-3xl')

let textareaEl: HTMLTextAreaElement | undefined = $state()
let selRange = $state<{ start: number; end: number } | null>(null)
let gen = $state<{ op: OpKind; instruction: string; anchor: number } | null>(null)
let shownLen = $state(0)
let userMoved = $state(false)
let abortRef: AbortController | null = null
let scrollEl: HTMLDivElement | undefined = $state()
/** Custom-instruction dialog (opened from the action bar). */
let customOpen = $state(false)
let customDlg: HTMLDialogElement | null = null
let instruction = $state('')
let customInput: HTMLTextAreaElement | undefined = $state()
/** Instruct-continuation dialog: continue from the cursor with custom guidance. */
let instructOpen = $state(false)
let instructDlg: HTMLDialogElement | null = null
let instructText = $state('')
let instructInput: HTMLTextAreaElement | undefined = $state()
/** The most recent generation in this doc, so Retry can re-send its exact request. */
let lastGen = $state<{
  op: OpKind
  instruction: string
  systemPrompt: string
  userMessage: string
  anchor: number
  before: string
  after: string
  output: string
} | null>(null)
/** Range of text added by the most recent generation (highlighted until the next edit). */
let newRange = $state<{ start: number; end: number } | null>(null)
let hlMirrorEl: HTMLDivElement | undefined = $state()
let hlRects = $state<{ left: number; top: number; width: number; height: number }[]>([])

const hasSelection = $derived(!!selRange && selRange.end - selRange.start > 0)
/** Selection ops are disabled without a selection, or while a generation is running. */
const opsDisabled = $derived(!!gen || !hasSelection)

$effect(() => {
  if (!hasSelection && customOpen) customOpen = false // nothing to apply a custom instruction to
})

// Keep the native <dialog> in sync with state (showModal gives focus trap + Esc).
$effect(() => {
  if (customDlg && customDlg.open !== customOpen) {
    if (customOpen) {
      customDlg.showModal()
      requestAnimationFrame(() => customInput?.focus())
    } else {
      customDlg.close()
    }
  }
})

function applyCustom() {
  const text = instruction.trim()
  if (!text || opsDisabled) return
  runOp('custom', text)
  customOpen = false
  instruction = ''
}

// Keep the native <dialog> in sync with state (showModal gives focus trap + Esc).
$effect(() => {
  if (instructDlg && instructDlg.open !== instructOpen) {
    if (instructOpen) {
      instructDlg.showModal()
      requestAnimationFrame(() => instructInput?.focus())
    } else {
      instructDlg.close()
    }
  }
})

function applyInstruct() {
  const text = instructText.trim()
  if (!text || gen) return
  runOp('instruct', text)
  instructOpen = false
  instructText = ''
}

// Report selection state (word count included) for the top bar's hint + op buttons.
$effect(() => {
  onSelectionChange({
    has: hasSelection,
    words: selRange ? wordCount(doc.content.slice(selRange.start, selRange.end)) : 0,
  })
})

// Tell App whether Retry can re-send this doc's last generation (top bar button state).
$effect(() => {
  void lastGen
  onRetryAvailable(!!lastGen)
})

function updateSelection() {
  const el = textareaEl
  if (!el) return
  userMoved = true // any manual caret interaction wins over auto-restoration
  selRange = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 }
}

/**
 * Project the newly-generated range onto the visible textarea via a hidden mirror
 * with identical typography. One overlay rect per line fragment the range spans;
 * the overlay lives inside the scroll container, so it scrolls with the text for free.
 */
function computeHighlight(content: string, range: { start: number; end: number }) {
  const el = textareaEl
  const m = hlMirrorEl
  if (!el || !m) return
  const cs = getComputedStyle(el)
  m.style.width = `${el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`
  m.textContent = ''
  const startMarker = document.createElement('span')
  const endMarker = document.createElement('span')
  m.append(
    document.createTextNode(content.slice(0, range.start)),
    startMarker,
    document.createTextNode(content.slice(range.start, range.end)),
    endMarker,
  )
  const r = document.createRange()
  r.setStart(startMarker, 0)
  r.setEnd(endMarker, 0)
  const mr = m.getBoundingClientRect()
  const lineH = parseFloat(cs.lineHeight) || 24
  hlRects = Array.from(r.getClientRects())
    .filter((rc) => rc.width > 0.5)
    .map((rc) => ({
      left: Math.max(0, rc.left - mr.left),
      top: Math.max(0, rc.top - mr.top),
      width: rc.width,
      height: rc.height >= 4 ? rc.height : lineH,
    }))
}

// Re-project the highlight whenever the text or its layout can move.
$effect(() => {
  const range = newRange
  const content = doc.content
  void fontSize
  void fontFamily
  void measure
  if (!range) {
    hlRects = []
    return
  }
  const t = requestAnimationFrame(() => computeHighlight(content, range))
  return () => cancelAnimationFrame(t)
})

// Keep the caret pinned to the end of streamed text (unless the user moved it).
$effect(() => {
  const g = gen
  if (!g || !textareaEl || userMoved) return
  const pos = g.anchor + shownLen
  try {
    textareaEl.setSelectionRange(pos, pos)
  } catch {
    /* ignore */
  }
})

$effect(() => {
  const cmd = command
  if (!cmd) return
  if (cmd.kind === 'insert') insertText(cmd.text)
  else if (cmd.kind === 'stop') stopGeneration()
  else if (cmd.kind === 'open-custom') customOpen = true
  else if (cmd.kind === 'open-instruct') instructOpen = true
  else void runOp(cmd.op, cmd.customInstruction)
  onCommandDone()
})

let prevLen = 0

// Auto-size the writing textarea so the editor fills the pane down to the bottom
// of the viewport (and scrolls only when the content outgrows it).
function fitEditor() {
  const el = textareaEl
  const sc = scrollEl
  if (!el || !sc) return
  requestAnimationFrame(() => {
    // Resetting the height collapses the box and clamps scroll positions to zero. The
    // visible scroller is usually the outer container (the textarea itself only grows),
    // so save and restore BOTH — otherwise typing yanks the view back to the top.
    const st = el.scrollTop
    const sst = sc.scrollTop
    const len = doc.content.length
    if (len < prevLen) {
      el.style.height = 'auto'
    }
    prevLen = len
    const minH = Math.max(120, sc.clientHeight - 36) // fills to the bottom: pt-8 (32px) top + pb-1 (4px)
    el.style.height = `${Math.max(el.scrollHeight, minH)}px`
    el.scrollTop = st
    sc.scrollTop = sst
  })
}

$effect(() => {
  void doc.content
  fitEditor()
})
$effect(() => {
  void fontSize
  void measure
  void fontFamily
  fitEditor()
})
$effect(() => {
  const sc = scrollEl
  if (!sc) return
  const ro = new ResizeObserver(() => fitEditor())
  ro.observe(sc)
  return () => ro.disconnect()
})

function handleInput(e: Event) {
  if (gen) return
  newRange = null // any manual edit clears the "new text" highlight
  doc.content = (e.target as HTMLTextAreaElement).value
  doc.updatedAt = Date.now()
  updateSelection()
}

function insertText(text: string) {
  if (!text) return
  const el = textareaEl
  const start = el?.selectionStart ?? doc.content.length
  const end = el?.selectionEnd ?? start
  doc.content = doc.content.slice(0, start) + text + doc.content.slice(end)
  doc.updatedAt = Date.now()
  requestAnimationFrame(() => {
    if (el) {
      el.selectionStart = el.selectionEnd = start + text.length
      userMoved = false
    }
  })
}

function stopGeneration() {
  abortRef?.abort()
}
async function runOp(op: OpKind, customInstruction?: string) {
  if (gen) return
  if (!profile) {
    onError('Set up a server profile first (gear icon → Servers).')
    return
  }
  if (!profile.modelId) {
    onError('Select a model for this profile first (gear icon → Servers).')
    return
  }

  const el = textareaEl
  let anchor: number
  let selEnd: number
  let selection = ''
  let req: BuiltRequest
  if (op === 'retry') {
    // Re-send the previous generation's exact request. If its output is still verbatim
    // at its anchor, replace it in place; if it was cleanly deleted, re-insert there.
    const prev = lastGen
    if (!prev) {
      onError('Nothing to retry yet — generate something first.')
      return
    }
    const intact = doc.content.slice(prev.anchor, prev.anchor + prev.output.length) === prev.output
    const removed = !intact && doc.content === prev.before + prev.after
    if (intact || removed) {
      anchor = prev.anchor
      selEnd = prev.anchor + (intact ? prev.output.length : 0)
      req = { systemPrompt: prev.systemPrompt, userMessage: prev.userMessage }
    } else if (prev.op === 'continue' || prev.op === 'instruct' || prev.op === 'retry') {
      // The doc changed since; continue fresh from the cursor with the same intent.
      anchor = el?.selectionStart ?? doc.content.length
      selEnd = anchor
      req =
        prev.op === 'instruct'
          ? buildInstructRequest(profile, doc, anchor, maxContext, prev.instruction)
          : buildContinueRequest(profile, doc, anchor, maxContext)
    } else {
      onError('The last generated text was edited. Select a passage to retry that operation.')
      return
    }
  } else if (op === 'continue' || op === 'instruct') {
    // Insertion ops: no selection needed, anchored at the caret.
    anchor = el?.selectionStart ?? doc.content.length
    selEnd = anchor
    req =
      op === 'instruct'
        ? buildInstructRequest(profile, doc, anchor, maxContext, customInstruction ?? '')
        : buildContinueRequest(profile, doc, anchor, maxContext)
  } else {
    if (!selRange || selRange.end - selRange.start < 1) {
      onError('Select some text first, then try again.')
      return
    }
    anchor = selRange.start
    selEnd = selRange.end
    selection = doc.content.slice(anchor, selEnd)
    req = buildOpRequest(profile, doc, op, selection, anchor, customInstruction)
  }

  const before = doc.content.slice(0, anchor)
  const after = doc.content.slice(selEnd)
  const label =
    op === 'custom' || op === 'instruct' ? (customInstruction?.trim() || OP_LABELS[op]) : OP_LABELS[op]

  gen = { op, instruction: label, anchor }
  userMoved = false
  selRange = null
  newRange = null // replaced by the highlight of this generation's output

  let full = ''
  let lastFlush = 0
  const estPrompt = estimateTokens(req.systemPrompt + '\n' + req.userMessage)
  onGenStats({ active: true, promptTokens: estPrompt, completionTokens: 0, label })

  const controller = new AbortController()
  abortRef = controller

  const recordGeneration = (promptTokens?: number, completionTokens?: number) => {
    if (!full.trim()) return
    onGeneration({
      id: uid(),
      ts: Date.now(),
      docId: doc.id,
      model: profile.modelId,
      op,
      instruction: op === 'custom' || op === 'instruct' ? (customInstruction?.trim() ?? '') : '',
      params: { ...profile.params },
      systemPrompt: req.systemPrompt,
      output: full,
      promptTokens: promptTokens ?? estPrompt,
      completionTokens: completionTokens ?? estimateTokens(full),
    })
  }

  try {
    const result = await chatStream(
      profile.baseUrl,
      profile.apiKey,
      profile.modelId,
      toMessages(req.systemPrompt, req.userMessage),
      profile.params,
      controller.signal,
      {
        onToken: (t) => {
          full += t
          const now = performance.now()
          if (now - lastFlush > 60 || t.length > 200) {
            // batched flush keeps UI updates efficient while feeling live
            lastFlush = now
            doc.content = before + full + after
            shownLen = full.length
          }
        },
        onUsage: (u) => {
          onGenStats({ active: true, promptTokens: u.prompt_tokens ?? estPrompt, completionTokens: u.completion_tokens ?? full.length, label })
        },
      },
    )
    recordGeneration(result.promptTokens, result.completionTokens)
    if (!full.trim() && op !== 'continue') {
      onError('The model returned no text. Check the model and temperature settings.')
    }
  } catch (e) {
    const err = e as Error
    if (err.name === 'AbortError') recordGeneration() // keep whatever partial text arrived
    else onError(err.message || 'Generation failed')
  } finally {
    doc.content = before + full + after
    shownLen = full.length
    doc.updatedAt = Date.now()
    // Highlight everything this generation added (works for both insert & replace ops).
    newRange = full.trim() ? { start: anchor, end: anchor + full.length } : null
    if (full.trim()) {
      lastGen = {
        op,
        instruction: customInstruction?.trim() ?? '',
        systemPrompt: req.systemPrompt,
        userMessage: req.userMessage,
        anchor,
        before,
        after,
        output: full,
      }
    }
    gen = null
    abortRef = null
    onGenStats({ active: false, promptTokens: 0, completionTokens: 0 })
  }
}
</script>

<div class="flex min-h-0 flex-1 flex-col bg-base-100">
  <div class="min-h-0 flex-1 overflow-y-auto" bind:this={scrollEl}>
    <div class={`mx-auto min-h-full px-6 pt-8 pb-1 ${measureClass}`}>
      <!-- relative wrapper == textarea box, so mirror-measured rects map 1:1 onto the overlay -->
      <div class="relative">
        {#each hlRects as r (r.top + ',' + r.left)}
          <span class="gen-new" style={`left: ${r.left}px; top: ${r.top}px; width: ${r.width}px; height: ${r.height}px`}></span>
        {/each}
        <textarea
          bind:this={textareaEl}
          class={`${familyClass} w-full resize-none bg-transparent leading-relaxed outline-none placeholder:opacity-40 ${fontClass}`}
          placeholder="Start writing… or select a passage to transform it."
          value={doc.content}
          readonly={!!gen}
          oninput={handleInput}
          onclick={updateSelection}
          onkeyup={updateSelection}
          onfocus={updateSelection}
          onselect={updateSelection}
        ></textarea>
      </div>
    </div>
  </div>

  <!-- Hidden mirror of the editor text; used to project the new-text highlight onto screen. -->
  <div
    bind:this={hlMirrorEl}
    aria-hidden="true"
    class={`${familyClass} leading-relaxed ${fontClass}`}
    style="position: absolute; top: 0; left: -9999px; visibility: hidden; white-space: pre-wrap; word-break: break-word;"
  ></div>

  <!-- Custom-instruction dialog -->
  <dialog bind:this={customDlg} class="modal" aria-label="Custom instruction">
    <form method="dialog" class="modal-box max-w-md">
      <h3 class="text-lg font-semibold">Custom instruction</h3>
      <p class="py-1 text-sm opacity-60">Tell the model what to do with the selected passage.</p>
      <textarea
        bind:this={customInput}
        rows={3}
        class="textarea textarea-bordered w-full"
        placeholder="e.g. Make this scene more tense…"
        value={instruction}
        oninput={(e) => (instruction = (e.target as HTMLTextAreaElement).value)}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            applyCustom()
          }
        }}
      ></textarea>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost" onclick={() => (customOpen = false)}>Cancel</button>
        <button type="submit" class="btn btn-primary" disabled={!instruction.trim()} onclick={applyCustom}>Apply to selection</button>
      </div>
    </form>
    <form method="dialog" class="modal-backdrop"><button>close</button></form>
  </dialog>

  <!-- Instruct-continuation dialog: continue from the cursor with custom guidance -->
  <dialog bind:this={instructDlg} class="modal" aria-label="Instruct continuation">
    <form method="dialog" class="modal-box max-w-md">
      <h3 class="text-lg font-semibold">Continue with instructions</h3>
      <p class="py-1 text-sm opacity-60">Tell the model how to continue the story from the cursor.</p>
      <textarea
        bind:this={instructInput}
        rows={3}
        class="textarea textarea-bordered w-full"
        placeholder="e.g. Have the storm arrive before midnight…"
        value={instructText}
        oninput={(e) => (instructText = (e.target as HTMLTextAreaElement).value)}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            applyInstruct()
          }
        }}
      ></textarea>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost" onclick={() => (instructOpen = false)}>Cancel</button>
        <button type="submit" class="btn btn-primary" disabled={!instructText.trim()} onclick={applyInstruct}>Continue</button>
      </div>
    </form>
    <form method="dialog" class="modal-backdrop"><button>close</button></form>
  </dialog>
</div>

