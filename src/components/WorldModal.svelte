<script lang="ts">
import type { StoryDoc } from '../lib/types'
import { uid } from '../lib/format'

let {
  open,
  onClose,
  doc,
}: {
  open: boolean
  onClose: () => void
  doc: StoryDoc | null
} = $props()

let dlg: HTMLDialogElement | undefined = $state()
$effect(() => {
  // showModal()/close() (not the `open` property) so Escape closes it natively.
  if (dlg && dlg.open !== open) (open ? dlg.showModal() : dlg.close())
})

function addNote() {
  if (!doc) return
  doc.worldNotes.push({ id: uid(), title: '', content: '' })
  doc.updatedAt = Date.now()
}
function removeNote(id: string) {
  if (!doc) return
  doc.worldNotes = doc.worldNotes.filter((n) => n.id !== id)
  doc.updatedAt = Date.now()
}
function addCharacter() {
  if (!doc) return
  doc.characters.push({ id: uid(), name: '', description: '' })
  doc.updatedAt = Date.now()
}
function removeCharacter(id: string) {
  if (!doc) return
  doc.characters = doc.characters.filter((c) => c.id !== id)
  doc.updatedAt = Date.now()
}
</script>

<dialog class="modal" aria-label="World notes" bind:this={dlg} onclose={onClose}>
  <div class="modal-box max-h-[80vh] w-full max-w-xl overflow-hidden">
    <h3 class="mb-3 shrink-0 text-lg font-bold"><i class="fa-solid fa-globe mr-2 text-primary"></i>World</h3>

    {#if doc}
      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <div>
          <span class="label pb-1 text-xs opacity-70">Tone &amp; style notes</span>
          <textarea
            class="textarea textarea-bordered w-full text-sm"
            rows={3}
            placeholder="e.g. Third person limited, present tense. Sparse, salt-worn prose."
            value={doc.tone}
            oninput={(e) => { doc.tone = (e.target as HTMLTextAreaElement).value; doc.updatedAt = Date.now() }}
          ></textarea>
        </div>

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
                <button class="btn btn-ghost btn-xs text-error hover:bg-error/10" onclick={() => removeNote(note.id)}>
                  <i class="fa-solid fa-trash"></i> Remove
                </button>
              </div>
            </div>
          {:else}
            <p class="px-1 text-xs opacity-50">No world notes yet. Add lore, places, and rules the model should respect.</p>
          {/each}
        </div>

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
                <button class="btn btn-ghost btn-xs text-error hover:bg-error/10" onclick={() => removeCharacter(ch.id)}>
                  <i class="fa-solid fa-trash"></i> Remove
                </button>
              </div>
            </div>
          {:else}
            <p class="px-1 text-xs opacity-50">No characters yet.</p>
          {/each}
        </div>

        <p class="px-1 text-[11px] leading-relaxed opacity-50">
          World notes, characters and tone are injected into the system prompt on every generation.
        </p>
      </div>
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