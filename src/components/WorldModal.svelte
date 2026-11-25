<script lang="ts">
import type { CharacterCard, StoryDoc, WorldNote } from '../lib/types'
import { uid } from '../lib/format'

let {
  open,
  onClose,
  doc,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  doc: StoryDoc | null
  onConfirm: (title: string, message: string, action: () => void, label?: string) => void
} = $props()

let dlg: HTMLDialogElement | undefined = $state()
$effect(() => {
  // showModal()/close() (not the `open` property) so Escape closes it natively.
  if (dlg && dlg.open !== open) (open ? dlg.showModal() : dlg.close())
})

/** Visible section: tone, world notes, or characters (tab bar). */
let activeTab = $state<'tone' | 'notes' | 'characters'>('tone')

function addNote() {
  if (!doc) return
  doc.worldNotes.push({ id: uid(), title: '', content: '' })
  doc.updatedAt = Date.now()
}
function removeNote(note: WorldNote) {
  if (!doc) return
  const name = note.title.trim() || 'Untitled note'
  onConfirm(
    'Delete world note',
    `Delete "${name}"? This cannot be undone.`,
    () => {
      if (!doc) return
      doc.worldNotes = doc.worldNotes.filter((n) => n.id !== note.id)
      doc.updatedAt = Date.now()
    },
    'Delete',
  )
}
function addCharacter() {
  if (!doc) return
  doc.characters.push({ id: uid(), name: '', description: '' })
  doc.updatedAt = Date.now()
}
function removeCharacter(ch: CharacterCard) {
  if (!doc) return
  const name = ch.name.trim() || 'Unnamed character'
  onConfirm(
    'Delete character',
    `Delete "${name}"? This cannot be undone.`,
    () => {
      if (!doc) return
      doc.characters = doc.characters.filter((c) => c.id !== ch.id)
      doc.updatedAt = Date.now()
    },
    'Delete',
  )
}
</script>

<dialog class="modal" aria-label="World notes" bind:this={dlg} onclose={onClose}>
  <div class="modal-box flex max-h-[85vh] min-h-[min(420px,60vh)] w-full max-w-3xl flex-col overflow-hidden">
    <h3 class="mb-3 shrink-0 text-lg font-bold"><i class="fa-solid fa-globe mr-2 text-primary"></i>World</h3>

    {#if doc}
      <!-- Tone / world notes / characters each get their own tab so the wider
           box never has to scroll through all three sections at once. -->
      <div class="tabs tabs-box mb-3 shrink-0" role="tablist">
        <button class="tab" role="tab" aria-selected={activeTab === 'tone'} onclick={() => (activeTab = 'tone')}>Tone</button>
        <button class="tab" role="tab" aria-selected={activeTab === 'notes'} onclick={() => (activeTab = 'notes')}>
          World notes{#if doc.worldNotes.length}<span class="badge badge-ghost badge-xs">{doc.worldNotes.length}</span>{/if}
        </button>
        <button class="tab" role="tab" aria-selected={activeTab === 'characters'} onclick={() => (activeTab = 'characters')}>
          Characters{#if doc.characters.length}<span class="badge badge-ghost badge-xs">{doc.characters.length}</span>{/if}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto pr-1" role="tabpanel">
        {#if activeTab === 'tone'}
          <div>
            <span class="label pb-1 text-xs opacity-70">Tone &amp; style notes</span>
            <textarea
              class="textarea textarea-bordered w-full text-sm"
              rows={6}
              placeholder="e.g. Third person limited, present tense. Sparse, salt-worn prose."
              value={doc.tone}
              oninput={(e) => { doc.tone = (e.target as HTMLTextAreaElement).value; doc.updatedAt = Date.now() }}
            ></textarea>
          </div>
        {:else if activeTab === 'notes'}
          <div>
            <div class="flex items-center justify-between pb-1">
              <span class="label text-xs opacity-70">World notes</span>
              <button class="btn btn-ghost btn-xs" title="Add world note" onclick={addNote}><i class="fa-solid fa-plus"></i></button>
            </div>
            {#each doc.worldNotes as note (note.id)}
              <div class="collapse collapse-arrow mb-1 rounded-lg bg-base-200">
                <input type="checkbox" />
                <div class="collapse-title px-3 text-sm font-medium">{note.title || 'Untitled note'}</div>
                <div class="collapse-content space-y-2 p-2">
                  <input
                    class="input input-bordered input-sm w-full"
                    placeholder="Title (shown in prompts)"
                    value={note.title}
                    oninput={(e) => { note.title = (e.target as HTMLInputElement).value; doc.updatedAt = Date.now() }}
                  />
                  <textarea
                    class="textarea textarea-bordered w-full text-sm"
                    rows={3}
                    placeholder="Details the model should know…"
                    value={note.content}
                    oninput={(e) => { note.content = (e.target as HTMLTextAreaElement).value; doc.updatedAt = Date.now() }}
                  ></textarea>
                  <button class="btn btn-ghost btn-xs text-error hover:bg-error/10" onclick={() => removeNote(note)}>
                    <i class="fa-solid fa-trash"></i> Remove
                  </button>
                </div>
              </div>
            {:else}
              <p class="px-1 text-xs opacity-50">No world notes yet. Add lore, places, and rules the model should respect.</p>
            {/each}
          </div>
        {:else}
          <div>
            <div class="flex items-center justify-between pb-1">
              <span class="label text-xs opacity-70">Characters</span>
              <button class="btn btn-ghost btn-xs" title="Add character" onclick={addCharacter}><i class="fa-solid fa-plus"></i></button>
            </div>
            {#each doc.characters as ch (ch.id)}
              <div class="collapse collapse-arrow mb-1 rounded-lg bg-base-200">
                <input type="checkbox" />
                <div class="collapse-title px-3 text-sm font-medium">{ch.name || 'Unnamed character'}</div>
                <div class="collapse-content space-y-2 p-2">
                  <input
                    class="input input-bordered input-sm w-full"
                    placeholder="Name"
                    value={ch.name}
                    oninput={(e) => { ch.name = (e.target as HTMLInputElement).value; doc.updatedAt = Date.now() }}
                  />
                  <textarea
                    class="textarea textarea-bordered w-full text-sm"
                    rows={3}
                    placeholder="Voice, goals, quirks…"
                    value={ch.description}
                    oninput={(e) => { ch.description = (e.target as HTMLTextAreaElement).value; doc.updatedAt = Date.now() }}
                  ></textarea>
                  <button class="btn btn-ghost btn-xs text-error hover:bg-error/10" onclick={() => removeCharacter(ch)}>
                    <i class="fa-solid fa-trash"></i> Remove
                  </button>
                </div>
              </div>
            {:else}
              <p class="px-1 text-xs opacity-50">No characters yet.</p>
            {/each}
          </div>
        {/if}
      </div>

      <p class="mt-3 shrink-0 px-1 text-[11px] leading-relaxed opacity-50">
        World notes, characters and tone are injected into the system prompt on every generation.
      </p>
    {:else}
      <p class="py-6 text-center text-sm opacity-50">Open a story to edit its world.</p>
    {/if}

    <div class="modal-action mt-3 shrink-0">
      <button class="btn" title="Close" onclick={onClose}>Close</button>
    </div>
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <form method="dialog" class="modal-backdrop" onclick={onClose}><button>close</button></form>
</dialog>