<script lang="ts">
import type { StoryDoc } from '../lib/types'
import { chapterDisplayTitle } from '../lib/chapters'
import { timeAgo, wordCount } from '../lib/format'

let {
  doc,
  genActive,
  open = true,
  width = 256,
  onToggleOpen,
  onResize,
  onSelectChapter,
  onAddChapter,
  onRenameChapter,
  onReorderChapter,
  onDeleteChapter,
  onSummarizeChapter,
  onUpdateSummary,
  onDismissStaleSummary,
}: {
  doc: StoryDoc
  genActive: boolean
  open?: boolean
  width?: number
  onToggleOpen?: () => void
  onResize?: (width: number) => void
  onSelectChapter: (id: string) => void
  onAddChapter: () => void
  onRenameChapter: (id: string, title: string) => void
  onReorderChapter?: (fromId: string, toId: string) => void
  onDeleteChapter: (id: string) => void
  onSummarizeChapter: (id: string) => void
  onUpdateSummary: (id: string, summary: string) => void
  onDismissStaleSummary?: (id: string) => void
} = $props()

const chapters = $derived(doc.chapters ?? [])
const activeId = $derived(doc.activeChapterId ?? chapters[0]?.id ?? null)
const includeSummaries = $derived(!!doc.includeChapterSummaries)

let editingId = $state<string | null>(null)
let renameDraft = $state('')
let renameInput: HTMLInputElement | undefined = $state()

$effect(() => {
  if (editingId && renameInput) {
    renameInput.focus()
    renameInput.select()
  }
})

function startRename(id: string, title: string) {
  editingId = id
  renameDraft = title
}

function commitRename() {
  if (!editingId) return
  onRenameChapter(editingId, renameDraft)
  editingId = null
}

function clickRow(id: string) {
  onSelectChapter(id)
}
function dblRow(id: string, title: string) {
  startRename(id, title)
}

const MIN_WIDTH = 180
const MAX_WIDTH = 480
let resizing = $state(false)
let dragId = $state<string | null>(null)
let dragOverId = $state<string | null>(null)

function handleEdgePointerDown(e: PointerEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startW = open ? width : 0
  let moved = false
  resizing = true

  function onMove(ev: PointerEvent) {
    const dx = ev.clientX - startX
    if (!moved && Math.abs(dx) < 4) return
    moved = true
    if (!open && dx > 4) {
      onToggleOpen?.()
    }
    const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(startW + dx)))
    onResize?.(next)
  }
  function onUp() {
    resizing = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (!moved) {
      onToggleOpen?.()
    }
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
</script>

<div class="relative flex shrink-0">
  <aside
    class={`flex shrink-0 flex-col overflow-hidden bg-base-200/50 ${resizing ? '' : 'transition-[width] duration-150'}`}
    style={`width: ${open ? width : 0}px`}
    aria-label="Chapters outline"
    aria-hidden={!open}
  >
  <div class="flex shrink-0 items-center gap-2 border-b border-base-300 px-3 py-2">
    <span class="text-xs font-semibold uppercase tracking-wider opacity-70">Chapters</span>
    <span class="badge badge-ghost badge-xs tabular-nums">{chapters.length}</span>
    <button
      class="btn btn-primary btn-xs ml-auto"
      title="New chapter"
      disabled={genActive}
      onclick={onAddChapter}
    >
      <i class="fa-solid fa-plus"></i>New
    </button>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
    <ul class="space-y-1">
      {#each chapters as ch, idx (ch.id)}
        {@const isActive = ch.id === activeId}
        {@const hasSummary = !!ch.summary?.trim()}
        {@const isSummaryOpen = isActive}
        <li
          class={`rounded-lg border-l-2 transition-colors ${isActive ? 'border-primary bg-base-300' : 'border-transparent hover:bg-base-300/60'} ${dragOverId === ch.id && dragId !== ch.id ? 'ring-1 ring-primary' : ''} ${dragId === ch.id ? 'opacity-50' : ''}`}
          draggable={!genActive && editingId !== ch.id}
          ondragstart={(e) => {
            if (genActive || editingId === ch.id || (e.target instanceof HTMLElement && e.target.closest('textarea, input'))) {
              e.preventDefault()
              return
            }
            dragId = ch.id
            e.dataTransfer?.setData('text/plain', ch.id)
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
          }}
          ondragover={(e) => {
            if (!dragId || dragId === ch.id) return
            e.preventDefault()
            dragOverId = ch.id
          }}
          ondragleave={() => {
            if (dragOverId === ch.id) dragOverId = null
          }}
          ondrop={(e) => {
            e.preventDefault()
            const from = dragId ?? e.dataTransfer?.getData('text/plain')
            dragId = null
            dragOverId = null
            if (from && from !== ch.id) onReorderChapter?.(from, ch.id)
          }}
          ondragend={() => {
            dragId = null
            dragOverId = null
          }}
        >
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="group flex cursor-pointer items-stretch gap-1 pr-1.5"
            onclick={(e) => {
              if (editingId === ch.id) return
              if ((e.target as HTMLElement).closest('button, input, [role="button"]')) return
              clickRow(ch.id)
            }}
          >
            {#if editingId === ch.id}
              <div class="w-full py-1.5 pl-2">
                <input
                  class="input input-bordered input-xs w-full"
                  bind:value={renameDraft}
                  bind:this={renameInput}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    else if (e.key === 'Escape') {
                      e.stopPropagation()
                      editingId = null
                    }
                  }}
                  onblur={commitRename}
                />
              </div>
            {:else}
              <button
                class="min-w-0 flex-1 py-1.5 pl-2 text-left"
                title={`${idx + 1}. ${chapterDisplayTitle(ch, idx)} (double-click to rename)`}
                onclick={() => clickRow(ch.id)}
                ondblclick={() => dblRow(ch.id, ch.title)}
              >
                <span class="flex items-center gap-1.5 text-xs font-medium">
                  <span class="shrink-0 tabular-nums opacity-50">{idx + 1}.</span>
                  <span class="truncate">{chapterDisplayTitle(ch, idx)}</span>
                </span>
                <span class="mt-0.5 flex items-center gap-1.5 text-[11px]">
                  <span class="tabular-nums opacity-50">{wordCount(ch.content).toLocaleString()} words</span>
                  <i
                    class={`fa-solid fa-wand-magic-sparkles text-[10px] ${hasSummary ? 'text-primary' : 'opacity-25'}`}
                    title={hasSummary
                      ? `Has summary${ch.summaryUpdatedAt ? ` (${timeAgo(ch.summaryUpdatedAt)})` : ''}`
                      : 'No summary yet'}
                  ></i>
                  {#if hasSummary && ch.summaryStale}
                    <span
                      role="button"
                      tabindex="0"
                      class="inline-flex cursor-pointer items-center rounded bg-warning px-1 py-0.5 text-warning-content shadow-xs hover:brightness-95"
                      title="Summary may be stale (chapter edited after auto-summary) — click to dismiss"
                      onclick={(e) => {
                        e.stopPropagation()
                        onDismissStaleSummary?.(ch.id)
                      }}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          onDismissStaleSummary?.(ch.id)
                        }
                      }}
                    >
                      <i class="fa-solid fa-triangle-exclamation text-[9px]"></i>
                    </span>
                  {/if}
                </span>
              </button>
            {/if}

            <div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100">
              <button
                class="btn btn-ghost btn-xs h-6 min-h-0 w-6 p-0"
                title="Rename chapter"
                disabled={genActive}
                onclick={() => startRename(ch.id, ch.title)}
              >
                <i class="fa-solid fa-pen text-[10px]"></i>
              </button>
              <button
                class="btn btn-ghost btn-xs h-6 min-h-0 w-6 p-0 text-error hover:bg-error/10"
                title="Delete chapter"
                disabled={genActive}
                onclick={() => onDeleteChapter(ch.id)}
              >
                <i class="fa-solid fa-trash text-[10px]"></i>
              </button>
            </div>
          </div>

          {#if isSummaryOpen}
            <div class="border-t border-base-300/70 px-2 py-2">
              <div class="mb-1 flex items-center justify-between gap-1">
                <span class="text-[11px] font-medium opacity-70">Summary</span>
                <button
                  class="btn btn-ghost btn-xs h-5 min-h-0 gap-1 px-1.5 text-[11px] text-primary"
                  title="Generate summary with AI"
                  disabled={genActive}
                  onclick={() => onSummarizeChapter(ch.id)}
                >
                  <i class="fa-solid fa-wand-magic-sparkles text-[10px]"></i>Auto
                </button>
              </div>
              <textarea
                rows={3}
                class="textarea textarea-bordered textarea-xs w-full text-xs leading-relaxed"
                placeholder="Write a 2–5 sentence summary for AI context…"
                value={ch.summary ?? ''}
                onblur={(e) => onUpdateSummary(ch.id, (e.target as HTMLTextAreaElement).value)}
              ></textarea>
              {#if hasSummary && ch.summaryStale}
                <div class="mt-1 flex items-center justify-between gap-1 rounded bg-warning px-1.5 py-0.5 text-[10px] font-medium text-warning-content">
                  <span class="flex items-center gap-1">
                    <i class="fa-solid fa-triangle-exclamation shrink-0"></i>
                    <span>Chapter edited — summary may be stale</span>
                  </span>
                  <button
                    class="link link-hover shrink-0 text-[10px] font-semibold"
                    title="Dismiss stale warning"
                    onclick={() => onDismissStaleSummary?.(ch.id)}
                  >
                    Dismiss
                  </button>
                </div>
              {/if}
              {#if !hasSummary && includeSummaries}
                <p class="mt-1 text-[10px] leading-snug opacity-60">
                  No summary yet — chapters without summaries are skipped in context.
                </p>
              {:else if ch.summaryUpdatedAt}
                <p class="mt-0.5 text-[10px] opacity-40">
                  Updated {timeAgo(ch.summaryUpdatedAt)}
                </p>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
  </aside>
  <!-- Persistent edge divider: click to minimize/expand, drag to resize -->
  <div
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize or toggle chapters outline"
    title={open ? 'Click to minimize outline · Drag to resize' : 'Click to expand outline'}
    class={`group relative flex w-2 shrink-0 cursor-col-resize items-center justify-center border-r border-base-300 transition-colors ${resizing ? 'bg-primary/40' : 'hover:bg-primary/20'}`}
    onpointerdown={handleEdgePointerDown}
  >
    <span class="h-8 w-0.5 rounded-full bg-base-content/20 transition-colors group-hover:bg-primary"></span>
  </div>
</div>
