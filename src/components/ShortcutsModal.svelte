<script lang="ts">
let { open, onClose }: { open: boolean; onClose: () => void } = $props()

let dlg: HTMLDialogElement | undefined = $state()
$effect(() => {
  // showModal()/close() (not the `open` property) so Escape closes it natively.
  if (dlg && dlg.open !== open) (open ? dlg.showModal() : dlg.close())
})
</script>

<dialog class="modal" bind:this={dlg} onclose={onClose}>
  <div class="modal-box max-w-md">
    <h3 class="mb-3 text-lg font-bold"><i class="fa-solid fa-keyboard mr-2 text-primary"></i>Keyboard shortcuts</h3>
    <ul class="space-y-1.5 text-sm">
      <li class="flex items-center justify-between gap-4"><span>Continue from cursor</span><kbd class="kbd kbd-sm">Ctrl</kbd> <kbd class="kbd kbd-sm">Enter</kbd></li>
      <li class="flex items-center justify-between gap-4"><span>Retry last generation</span><span><kbd class="kbd kbd-sm">Ctrl</kbd> <kbd class="kbd kbd-sm">Shift</kbd> <kbd class="kbd kbd-sm">Y</kbd></span></li>
      <li class="flex items-center justify-between gap-4"><span>Expand selection</span><span><kbd class="kbd kbd-sm">Ctrl</kbd> <kbd class="kbd kbd-sm">Shift</kbd> <kbd class="kbd kbd-sm">E</kbd></span></li>
      <li class="flex items-center justify-between gap-4"><span>Condense selection</span><span><kbd class="kbd kbd-sm">Ctrl</kbd> <kbd class="kbd kbd-sm">Shift</kbd> <kbd class="kbd kbd-sm">C</kbd></span></li>
      <li class="flex items-center justify-between gap-4"><span>Grammar-fix selection</span><span><kbd class="kbd kbd-sm">Ctrl</kbd> <kbd class="kbd kbd-sm">Shift</kbd> <kbd class="kbd kbd-sm">G</kbd></span></li>
      <li class="flex items-center justify-between gap-4"><span>Toggle chapters outline</span><span><kbd class="kbd kbd-sm">Ctrl</kbd> <kbd class="kbd kbd-sm">Shift</kbd> <kbd class="kbd kbd-sm">L</kbd></span></li>
      <li class="flex items-center justify-between gap-4"><span>Show this help</span><kbd class="kbd kbd-sm">F1</kbd></li>
      <li class="flex items-center justify-between gap-4"><span>Close dialogs</span><kbd class="kbd kbd-sm">Esc</kbd></li>
    </ul>
    <p class="mt-3 text-xs opacity-60">On macOS, use ⌘ instead of Ctrl. Selection shortcuts need a highlighted passage.</p>
    <div class="modal-action mt-4">
      <button class="btn" onclick={onClose}>Close</button>
    </div>
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <form method="dialog" class="modal-backdrop" onclick={onClose}><button>close</button></form>
</dialog>
