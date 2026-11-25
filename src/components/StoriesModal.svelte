<script lang="ts">
import type { StoryDoc } from '../lib/types'
import { timeAgo, wordCount } from '../lib/format'

let {
  open,
  onClose,
  docs,
  activeId,
  onSelect,
  onNew,
  onImportFile,
  onExport,
  onDelete,
}: {
  open: boolean
  onClose: () => void
  docs: StoryDoc[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onImportFile: (file: File) => void
  onExport: (doc: StoryDoc) => void
  onDelete: (id: string) => void
} = $props()

let dlg: HTMLDialogElement | undefined = $state()
$effect(() => {
  // showModal()/close() (not the `open` property) so Escape closes it natively.
  if (dlg && dlg.open !== open) (open ? dlg.showModal() : dlg.close())
})

/** Rename via the pencil button or by double-clicking a title — inline input; Enter/blur commits, Esc cancels. */
let editingId = $state<string | null>(null)
let renameDraft = $state('')
let renameInput: HTMLInputElement | undefined = $state()
/** Set when Escape cancels a rename so the dialog's native `cancel` (Esc closes showModal
 *  dialogs) is suppressed for that one press — the modal itself stays open. */
let suppressCancel = false
$effect(() => {
  // Programmatic focus (Svelte 5 warns against the `autofocus` attribute).
  if (editingId && renameInput) {
    renameInput.focus()
    renameInput.select()
  }
})
$effect(() => {
  if (!open) {
    editingId = null
    renameDraft = ''
    suppressCancel = false
    if (openTimer) {
      clearTimeout(openTimer)
      openTimer = null
    }
  }
})

function startRename(id: string, title: string) {
  editingId = id
  renameDraft = title
}

/** Single click opens a story (after a short delay so a double-click can win);
 *  double-click renames inline instead. */
let openTimer: ReturnType<typeof setTimeout> | null = null
function clickRow(doc: StoryDoc) {
  if (openTimer) return // second click of a double-click; ondblclick handles it
  openTimer = setTimeout(() => {
    openTimer = null
    if (open) onSelect(doc.id)
  }, 250)
}
function dblRow(doc: StoryDoc) {
  if (openTimer) {
    clearTimeout(openTimer)
    openTimer = null
  }
  startRename(doc.id, doc.title)
}

function commitRename() {
  const d = docs.find((x) => x.id === editingId)
  if (d) {
    d.title = renameDraft.trim() || 'Untitled story'
    d.updatedAt = Date.now()
  }
  editingId = null
}

/** Esc while renaming cancels the rename only; natively it would close the whole modal. */
function onCancel(e: Event) {
  if (suppressCancel) {
    e.preventDefault()
    suppressCancel = false
  }
}
</script>

<dialog class="modal" aria-label="Stories" bind:this={dlg} onclose={onClose} oncancel={onCancel}>
  <div class="modal-box max-h-[80vh] w-full max-w-lg overflow-hidden">
    <div class="mb-3 flex shrink-0 items-center gap-2">
      <h3 class="text-lg font-bold"><i class="fa-solid fa-book-open mr-2 text-primary"></i>Stories</h3>
      <span class="badge badge-ghost badge-sm">{docs.length}</span>
      <div class="ml-auto flex items-center gap-1">
        <label class="btn btn-ghost btn-xs cursor-pointer" title="Import a .txt file or a saved project (.json)">
          <i class="fa-solid fa-file-import"></i>
          <input
            type="file"
            accept=".txt,.md,.json,text/plain,application/json"
            class="hidden"
            onchange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0]
              if (f) onImportFile(f)
              ;(e.target as HTMLInputElement).value = ''
            }}
          />
        </label>
        <button class="btn btn-primary btn-xs" title="New story" onclick={onNew}>
          <i class="fa-solid fa-plus"></i>New
        </button>
      </div>
    </div>

    <div class="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
      {#if docs.length}
        <ul class="space-y-1">
          {#each docs as doc (doc.id)}
            <li
              class={`group flex items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-base-300 ${doc.id === activeId ? 'bg-base-300' : ''}`}
            >
              {#if editingId === doc.id}
                <input
                  class="input input-bordered input-sm w-full"
                  bind:value={renameDraft}
                  bind:this={renameInput}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    else if (e.key === 'Escape') {
                      suppressCancel = true // Esc cancels the rename, not the modal
                      editingId = null
                    }
                  }}
                  onblur={commitRename}
                />
              {:else}
                <button
                  class="min-w-0 flex-1 text-left"
                  title="Open story (double-click to rename)"
                  onclick={() => clickRow(doc)}
                  ondblclick={() => dblRow(doc)}
                >
                  <span class="block truncate text-sm font-medium">{doc.title}</span>
                  <span class="block text-[11px] opacity-50">
                    {wordCount(doc.content).toLocaleString()} words · {timeAgo(doc.updatedAt)}
                  </span>
                </button>
              {/if}
              <button
                class="btn btn-ghost btn-xs shrink-0 opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100 max-sm:h-8 max-sm:w-8"
                title="Rename story"
                onclick={() => startRename(doc.id, doc.title)}
              >
                <i class="fa-solid fa-pen"></i>
              </button>
              <button
                class="btn btn-ghost btn-xs shrink-0 opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100 max-sm:h-8 max-sm:w-8"
                title="Export as .txt"
                onclick={() => onExport(doc)}
              >
                <i class="fa-solid fa-file-export"></i>
              </button>
              <button
                class="btn btn-ghost btn-xs shrink-0 text-error opacity-0 transition-opacity hover:bg-error/10 group-hover:opacity-100 max-md:opacity-100 max-sm:h-8 max-sm:w-8"
                title="Delete story"
                onclick={() => onDelete(doc.id)}
              >
                <i class="fa-solid fa-trash"></i>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="px-2 py-8 text-center text-sm opacity-50">No stories yet. Create one or import a file.</p>
      {/if}
    </div>

    <div class="modal-action mt-3 shrink-0">
      <button class="btn" title="Close" onclick={onClose}>Close</button>
    </div>
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <form method="dialog" class="modal-backdrop" onclick={onClose}><button>close</button></form>
</dialog>