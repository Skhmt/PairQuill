<script lang="ts">
import type { ContentRating, EditorCommand, GenStats, GenerationRecord, OpKind, SamplingParams, ServerProfile, StoryDoc } from '../lib/types'
import { uid, wordCount } from '../lib/format'
import { estimateTokens } from '../lib/tokens'
import { chatStream } from '../lib/llm'
import { OP_LABELS, buildChapterContext, buildContinueRequest, buildInstructRequest, buildOpRequest, effectiveMaxTokens, toMessages } from '../lib/prompts'
import type { BuiltRequest } from '../lib/prompts'
import { chapterDisplayTitle, storyText } from '../lib/chapters'

let {
  doc,
  chapterId = null,
  storyMode = false,
  scrollToChapter = null,
  profile,
  command,
  maxContext,
  maxReplyTokens,
  rating,
  fontSize,
  measure,
  fontFamily,
  onRetryAvailable,
  onCommandDone,
  onGeneration,
  onGenStats,
  onSelectionChange,
  onFocusChapter,
  onError,
}: {
  doc: StoryDoc
  chapterId?: string | null
  storyMode?: boolean
  scrollToChapter?: { id: string; seq: number } | null
  profile: ServerProfile | null
  command: EditorCommand | null
  maxContext: number
  /** Effective cap for reply length in tokens (top-bar slider ∩ profile max tokens). */
  maxReplyTokens: number
  /** Content rating from the top-bar slider; its guidance block goes into every system prompt. */
  rating: ContentRating
  fontSize: 'sm' | 'md' | 'lg'
  measure: 'narrow' | 'normal' | 'wide'
  fontFamily: 'serif' | 'sans' | 'mono'
  /** Reports whether this doc has a generation Retry can re-send (top bar button state). */
  onRetryAvailable: (has: boolean) => void
  onCommandDone: () => void
  onGeneration: (g: GenerationRecord) => void
  onGenStats: (s: GenStats) => void
  onSelectionChange: (info: { has: boolean; words: number }) => void
  onFocusChapter?: (id: string) => void
  onError: (msg: string) => void
} = $props()

let chapterEls = $state<Record<string, HTMLTextAreaElement>>({})
let chapterHeaderEls = $state<Record<string, HTMLDivElement>>({})
let focusedChapterId = $state<string | null>(null)
let hlChapterId = $state<string | null>(null)

const targetChapter = $derived(doc.chapters?.find((c) => c.id === chapterId) ?? null)
const activeTargetChapter = $derived(
  storyMode
    ? (doc.chapters?.find((c) => c.id === (focusedChapterId ?? doc.activeChapterId)) ?? doc.chapters?.[0] ?? null)
    : targetChapter,
)
const currentText = $derived(activeTargetChapter ? activeTargetChapter.content : doc.content)

function commitText(v: string, ch = activeTargetChapter) {
  if (ch) {
    if (ch.content !== v) {
      ch.content = v
      if (ch.summarySource === 'auto' && ch.summary?.trim()) {
        ch.summaryStale = true
      }
    }
    doc.content = storyText(doc)
  } else {
    doc.content = v
  }
  doc.updatedAt = Date.now()
}

function chapterDocOffset(chId: string): number {
  if (!doc.chapters) return 0
  let pos = 0
  for (const c of doc.chapters) {
    if (c.id === chId) return pos
    pos += c.content.length + 2 // '\n\n' join separator
  }
  return pos
}

const fontClass = $derived(fontSize === 'sm' ? 'text-[15px] max-sm:text-base' : fontSize === 'lg' ? 'text-lg' : 'text-base')
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

const activeEl = $derived(storyMode ? (activeTargetChapter ? chapterEls[activeTargetChapter.id] : undefined) : textareaEl)

// Report selection state (word count included) for the top bar's hint + op buttons.
$effect(() => {
  if (!hasSelection || !selRange) {
    onSelectionChange({ has: false, words: 0 })
    return
  }
  onSelectionChange({
    has: true,
    words: wordCount(currentText.slice(selRange.start, selRange.end)),
  })
})

// Tell App whether Retry can re-send this doc's last generation (top bar button state).
$effect(() => {
  void lastGen
  onRetryAvailable(!!lastGen)
})

function updateSelection() {
  const el = activeEl
  if (!el) return
  userMoved = true // any manual caret interaction wins over auto-restoration
  const start = el.selectionStart ?? 0
  const end = el.selectionEnd ?? 0
  selRange = { start, end }
}

// Scroll to and focus a chapter when clicked in the outline in Full-story mode.
$effect(() => {
  const target = scrollToChapter
  if (!target || !storyMode) return
  focusedChapterId = target.id
  requestAnimationFrame(() => {
    chapterHeaderEls[target.id]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    chapterEls[target.id]?.focus({ preventScroll: true })
  })
})

/**
 * Project the newly-generated range onto the visible textarea via a hidden mirror
 * with identical typography. One overlay rect per line fragment the range spans;
 * the overlay lives inside the scroll container, so it scrolls with the text for free.
 */
function computeHighlight(range: { start: number; end: number }) {
  const el = storyMode && hlChapterId ? chapterEls[hlChapterId] : textareaEl
  const m = hlMirrorEl
  if (!el || !m) return
  // Measure against the textarea's *actual* rendered text (its value is what the
  // browser laid out), clamped to its length — a stale `content` closure would shift
  // every rect and can make the highlight vanish.
  const text = el.value
  const start = Math.max(0, Math.min(range.start, text.length))
  const end = Math.max(start, Math.min(range.end, text.length))
  if (end - start <= 0) {
    hlRects = []
    return
  }
  const cs = getComputedStyle(el)
  const padL = parseFloat(cs.paddingLeft) || 0
  const padT = parseFloat(cs.paddingTop) || 0
  const width = el.clientWidth - padL - (parseFloat(cs.paddingRight) || 0)
  if (width <= 0) return // pane hidden — nothing to project
  m.style.width = `${width}px`
  m.textContent = ''
  const startMarker = document.createElement('span')
  const endMarker = document.createElement('span')
  m.append(
    document.createTextNode(text.slice(0, start)),
    startMarker,
    document.createTextNode(text.slice(start, end)),
    endMarker,
  )
  const r = document.createRange()
  r.setStart(startMarker, 0)
  r.setEnd(endMarker, 0)
  const mr = m.getBoundingClientRect()
  const lineH = parseFloat(cs.lineHeight) || 24
  // The mirror has no padding; the textarea's text starts padL/padT inside its box.
  // Zero-height rects (empty lines) get the line height so they stay visible.
  hlRects = Array.from(r.getClientRects())
    .filter((rc) => rc.width > 0.5)
    .map((rc) => ({
      left: Math.max(0, rc.left - mr.left + padL),
      top: Math.max(0, rc.top - mr.top + padT),
      width: rc.width,
      height: rc.height >= 4 ? rc.height : lineH,
    }))
}

// Re-project the highlight whenever the text or its layout can move.
$effect(() => {
  const range = newRange
  void currentText // content changes re-project (no-op while a generation is running)
  void fontSize
  void fontFamily
  void measure
  if (!range) {
    hlRects = []
    return
  }
  const t = requestAnimationFrame(() => computeHighlight(range))
  return () => cancelAnimationFrame(t)
})

// Keep the caret pinned to the end of streamed text (unless the user moved it).
$effect(() => {
  const g = gen
  const el = activeEl
  if (!g || !el || userMoved) return
  const pos = g.anchor + shownLen
  try {
    el.setSelectionRange(pos, pos)
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
let fitRaf = 0
const MAX_UNDO = 30
let undoStack: string[] = []
/** Tracks the last doc.content produced by a programmatic edit so Ctrl+Z undoes AI ops without hijacking manual typing undo. */
let lastProgrammaticContent: string | null = null

function pushUndo(snapshot: string) {
  if (undoStack[undoStack.length - 1] === snapshot) return
  undoStack.push(snapshot)
  if (undoStack.length > MAX_UNDO) undoStack.shift()
}

function handleEditorKeydown(e: KeyboardEvent) {
  if (gen) return
  const mod = e.ctrlKey || e.metaKey
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
    if (undoStack.length > 0 && lastProgrammaticContent === currentText) {
      e.preventDefault()
      const prev = undoStack.pop()!
      commitText(prev)
      lastProgrammaticContent = undoStack.length > 0 ? prev : null
      newRange = null
    }
  }
}

// Auto-size the writing textarea(s) so the editor fills the pane down to the bottom
// of the viewport (and scrolls only when the content outgrows it).
function fitEditor() {
  const sc = scrollEl
  if (!sc) return
  if (fitRaf) cancelAnimationFrame(fitRaf)
  fitRaf = requestAnimationFrame(() => {
    fitRaf = 0
    const sst = sc.scrollTop
    if (storyMode) {
      for (const ch of doc.chapters ?? []) {
        const el = chapterEls[ch.id]
        if (!el) continue
        const st = el.scrollTop
        el.style.height = 'auto'
        el.style.height = `${Math.max(el.scrollHeight, 120)}px`
        el.scrollTop = st
      }
      sc.scrollTop = sst
      return
    }
    const el = textareaEl
    if (!el) return
    const st = el.scrollTop
    const len = currentText.length
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
  void currentText
  if (storyMode && doc.chapters) {
    for (const c of doc.chapters) void c.content
  }
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
  return () => {
    ro.disconnect()
    if (fitRaf) {
      cancelAnimationFrame(fitRaf)
      fitRaf = 0
    }
  }
})

function handleInput(e: Event) {
  if (gen) return
  lastProgrammaticContent = null
  newRange = null // any manual edit clears the "new text" highlight
  commitText((e.target as HTMLTextAreaElement).value)
  updateSelection()
}

function insertText(text: string) {
  if (!text) return
  const el = activeEl
  const start = el?.selectionStart ?? currentText.length
  const end = el?.selectionEnd ?? start
  pushUndo(currentText)
  const next = currentText.slice(0, start) + text + currentText.slice(end)
  commitText(next)
  lastProgrammaticContent = next
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
  // The top-bar slider caps reply length; the profile's own max tokens (if set) is a hard cap.
  const effParams: SamplingParams = { ...profile.params, maxTokens: effectiveMaxTokens(profile, maxReplyTokens) }
  const opChapter = activeTargetChapter
  const chapterCtx = buildChapterContext(doc)
  const chapterIdx = opChapter && doc.chapters ? doc.chapters.indexOf(opChapter) : -1
  const chapterTitle = opChapter && chapterIdx >= 0 ? chapterDisplayTitle(opChapter, chapterIdx) : undefined
  const docOffset = storyMode && opChapter ? chapterDocOffset(opChapter.id) : 0

  const el = activeEl
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
    const intact = currentText.slice(prev.anchor, prev.anchor + prev.output.length) === prev.output
    const removed = !intact && currentText === prev.before + prev.after
    if (intact || removed) {
      anchor = prev.anchor
      selEnd = prev.anchor + (intact ? prev.output.length : 0)
      req = { systemPrompt: prev.systemPrompt, userMessage: prev.userMessage }
    } else if (prev.op === 'continue' || prev.op === 'instruct' || prev.op === 'retry') {
      // The doc changed since; continue fresh from the cursor with the same intent.
      anchor = el?.selectionStart ?? currentText.length
      selEnd = anchor
      const promptPos = docOffset + anchor
      req =
        prev.op === 'instruct'
          ? buildInstructRequest(profile, doc, promptPos, maxContext, prev.instruction, rating, effParams.maxTokens, chapterCtx)
          : buildContinueRequest(profile, doc, promptPos, maxContext, rating, effParams.maxTokens, chapterCtx)
    } else {
      onError('The last generated text was edited. Select a passage to retry that operation.')
      return
    }
  } else if (op === 'continue' || op === 'instruct') {
    // Insertion ops: no selection needed, anchored at the caret.
    anchor = el?.selectionStart ?? currentText.length
    selEnd = anchor
    const promptPos = docOffset + anchor
    req =
      op === 'instruct'
        ? buildInstructRequest(profile, doc, promptPos, maxContext, customInstruction ?? '', rating, effParams.maxTokens, chapterCtx)
        : buildContinueRequest(profile, doc, promptPos, maxContext, rating, effParams.maxTokens, chapterCtx)
  } else {
    if (!selRange || selRange.end - selRange.start < 1) {
      onError('Select some text first, then try again.')
      return
    }
    anchor = selRange.start
    selEnd = selRange.end
    selection = currentText.slice(anchor, selEnd)
    req = buildOpRequest(profile, doc, op, selection, docOffset + anchor, rating, customInstruction, chapterCtx)
  }

  const originalContent = currentText
  const before = originalContent.slice(0, anchor)
  const after = originalContent.slice(selEnd)
  const isReplaceOp = anchor !== selEnd
  const label =
    op === 'custom' || op === 'instruct' ? (customInstruction?.trim() || OP_LABELS[op]) : OP_LABELS[op]

  gen = { op, instruction: label, anchor }
  hlChapterId = opChapter?.id ?? null
  userMoved = false
  selRange = null
  newRange = null // replaced by the highlight of this generation's output

  let full = ''
  let lastFlush = 0
  let undoPushed = false
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
      params: effParams,
      systemPrompt: req.systemPrompt,
      output: full,
      promptTokens: promptTokens ?? estPrompt,
      completionTokens: completionTokens ?? estimateTokens(full),
      ...(opChapter ? { chapterId: opChapter.id, chapterTitle } : {}),
    })
  }

  let aborted = false
  let failed = false
  try {
    const result = await chatStream(
      profile.baseUrl,
      profile.apiKey,
      profile.modelId,
      toMessages(req.systemPrompt, req.userMessage),
      effParams,
      controller.signal,
      {
        onToken: (t) => {
          full += t
          const now = performance.now()
          if (now - lastFlush > 60 || t.length > 200) {
            // batched flush keeps UI updates efficient while feeling live
            if (!undoPushed) {
              pushUndo(originalContent)
              undoPushed = true
            }
            lastFlush = now
            commitText(before + full + after, opChapter)
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
    if (err.name === 'AbortError') {
      aborted = true
      recordGeneration() // keep whatever partial text arrived
    } else {
      failed = true
      onError(err.message || 'Generation failed')
    }
  } finally {
    // Never delete a replaced selection if the request failed, returned empty text, or produced nothing.
    const shouldRestore =
      full.length === 0 ||
      (!full.trim() && isReplaceOp) ||
      (failed && isReplaceOp && !aborted)

    if (shouldRestore) {
      if (undoPushed) undoStack.pop()
      if ((opChapter ? opChapter.content : doc.content) !== originalContent) {
        commitText(originalContent, opChapter)
      }
      shownLen = 0
      newRange = null
    } else {
      if (!undoPushed) pushUndo(originalContent)
      const finalContent = before + full + after
      commitText(finalContent, opChapter)
      lastProgrammaticContent = finalContent
      shownLen = full.length
      // Highlight everything this generation added (works for both insert & replace ops).
      newRange = full.trim() ? { start: anchor, end: anchor + full.length } : null
    }
    if (full.trim() && !shouldRestore) {
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
    <div class={`mx-auto min-h-full px-4 pt-4 sm:px-6 sm:pt-8 pb-1 ${measureClass}`}>
      {#if storyMode}
        {#each doc.chapters ?? [] as ch, idx (ch.id)}
          <div
            bind:this={chapterHeaderEls[ch.id]}
            class={`mb-3 flex items-center gap-2 border-b border-base-300 pb-1.5 ${idx > 0 ? 'mt-8' : ''}`}
          >
            <input
              type="text"
              class={`${familyClass} w-full bg-transparent text-xl font-bold tracking-tight outline-none placeholder:opacity-40 focus:text-primary`}
              value={ch.title}
              placeholder={`Chapter ${idx + 1}`}
              aria-label={`Chapter ${idx + 1} title`}
              oninput={(e) => {
                ch.title = (e.target as HTMLInputElement).value
                doc.updatedAt = Date.now()
              }}
              onblur={(e) => {
                ch.title = (e.target as HTMLInputElement).value.trim()
                doc.updatedAt = Date.now()
              }}
            />
          </div>
          <div class="relative">
            {#if hlChapterId === ch.id}
              {#each hlRects as r, i (`${i}:${r.top},${r.left}`)}
                <span class="gen-new" style={`left: ${r.left}px; top: ${r.top + r.height - 2}px; width: ${r.width}px`}></span>
              {/each}
            {/if}
            <textarea
              bind:this={chapterEls[ch.id]}
              class={`${familyClass} w-full resize-none overflow-hidden bg-transparent leading-relaxed outline-none placeholder:opacity-40 ${fontClass}`}
              placeholder="Start writing… or select a passage to transform it."
              value={ch.content}
              readonly={!!gen}
              onfocus={() => {
                focusedChapterId = ch.id
                onFocusChapter?.(ch.id)
                updateSelection()
              }}
              oninput={(e) => {
                if (gen) return
                lastProgrammaticContent = null
                newRange = null
                focusedChapterId = ch.id
                commitText((e.target as HTMLTextAreaElement).value, ch)
                updateSelection()
              }}
              onkeydown={handleEditorKeydown}
              onclick={updateSelection}
              onkeyup={updateSelection}
              onselect={updateSelection}
            ></textarea>
          </div>
        {/each}
      {:else}
        <!-- relative wrapper == textarea box, so mirror-measured rects map 1:1 onto the overlay -->
        <div class="relative">
          {#each hlRects as r, i (`${i}:${r.top},${r.left}`)}
            <!-- Underline bar along the bottom of each line fragment the new text spans. -->
            <span class="gen-new" style={`left: ${r.left}px; top: ${r.top + r.height - 2}px; width: ${r.width}px`}></span>
          {/each}
          <textarea
            bind:this={textareaEl}
            class={`${familyClass} w-full resize-none overflow-hidden bg-transparent leading-relaxed outline-none placeholder:opacity-40 ${fontClass}`}
            placeholder="Start writing… or select a passage to transform it."
            value={currentText}
            readonly={!!gen}
            oninput={handleInput}
            onkeydown={handleEditorKeydown}
            onclick={updateSelection}
            onkeyup={updateSelection}
            onfocus={updateSelection}
            onselect={updateSelection}
          ></textarea>
        </div>
      {/if}
    </div>
  </div>

  <!-- Hidden mirror of the editor text; used to project the new-text highlight onto screen. -->
  <div
    bind:this={hlMirrorEl}
    aria-hidden="true"
    class={`${familyClass} leading-relaxed ${fontClass}`}
    style="position: absolute; top: 0; left: -9999px; visibility: hidden; white-space: pre-wrap; overflow-wrap: break-word;"
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

