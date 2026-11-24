<script lang="ts">
  import pkg from "../../package.json";

  let { open, onClose }: { open: boolean; onClose: () => void } = $props();

  let dlg: HTMLDialogElement | undefined = $state();
  $effect(() => {
    // showModal()/close() (not the `open` property) so Escape closes it natively.
    if (dlg && dlg.open !== open) open ? dlg.showModal() : dlg.close();
  });
</script>

<dialog class="modal" bind:this={dlg} onclose={onClose}>
  <div class="modal-box max-w-sm text-center">
    <i class="fa-solid fa-feather-pointed mb-2 text-3xl text-primary"></i>
    <h3 class="text-lg font-bold">PairQuill</h3>
    <p class="mt-1 text-sm opacity-70">Version {pkg.version}</p>
    <p class="text-sm opacity-70">License: {pkg.license}</p>
    <a
      href="https://github.com/skhmt/pairquill"
      target="_blank"
      rel="noopener noreferrer"
      class="link link-primary mt-3 inline-flex items-center gap-2 text-sm"
    >
      <!-- <i class="fa-brands fa-github"></i> -->
      github.com/skhmt/pairquill
    </a>
    <div class="modal-action justify-center">
      <button class="btn" onclick={onClose}>Close</button>
    </div>
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <form method="dialog" class="modal-backdrop" onclick={onClose}>
    <button>close</button>
  </form>
</dialog>
