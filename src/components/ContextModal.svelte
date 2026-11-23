<script lang="ts">
import type { BudgetBreakdown, StoryDoc } from '../lib/types'

let {
  open,
  onClose,
  doc,
  budget,
  maxContext,
  modelLabel,
  exceedsModel,
  modelContext,
}: {
  open: boolean
  onClose: () => void
  doc: StoryDoc | null
  budget: BudgetBreakdown | null
  maxContext: number
  modelLabel: string
  exceedsModel: boolean
  modelContext?: number
} = $props()

let dlg: HTMLDialogElement | undefined = $state()
$effect(() => {
  // showModal()/close() (not the `open` property) so Escape closes it natively.
  if (dlg && dlg.open !== open) (open ? dlg.showModal() : dlg.close())
})

const pct = (t: number) => (maxContext > 0 ? Math.max(0, Math.min(100, (t / maxContext) * 100)) : 0)
</script>

<dialog class="modal" bind:this={dlg} onclose={onClose}>
  <div class="modal-box max-h-[80vh] w-full max-w-xl overflow-hidden">
    <h3 class="mb-3 shrink-0 text-lg font-bold"><i class="fa-solid fa-chart-simple mr-2 text-primary"></i>Context</h3>

    {#if doc}
      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <div>
          <span class="label pb-1 text-xs opacity-70">Max context (tokens)</span>
          <div class="flex items-center gap-2">
            <input
              type="number"
              min={512}
              step={512}
              class="input input-bordered input-sm w-full"
              placeholder={`auto: ${maxContext}`}
              value={doc.contextOverride ?? ''}
              onchange={(e) => {
                const v = Number((e.target as HTMLInputElement).value)
                doc.contextOverride = v > 0 ? Math.floor(v) : null
                doc.updatedAt = Date.now()
              }}
            />
            <span class="shrink-0 text-[11px] opacity-50" title="Model">{modelLabel || '—'}</span>
          </div>
          <p class="mt-1 text-[11px] opacity-50">Leave empty to use the model's reported context length.</p>
          {#if exceedsModel}
            <p class="mt-1 flex items-start gap-1.5 text-[11px] font-medium text-warning">
              <i class="fa-solid fa-triangle-exclamation mt-0.5 shrink-0"></i>
              <span>
                This override exceeds the model's reported context length ({modelContext?.toLocaleString()}). The server may truncate or reject prompts this large.
              </span>
            </p>
          {/if}
        </div>

        {#if budget}
          <div>
            <span class="label pb-1 text-xs opacity-70">Prompt budget</span>
            <div class="flex h-3 w-full overflow-hidden rounded-full bg-base-300" role="img" aria-label="Context budget breakdown">
              <div class="bg-primary" style={`width: ${pct(budget.systemTokens)}%`} title={`System prompt: ${budget.systemTokens}`}></div>
              <div class="bg-secondary" style={`width: ${pct(budget.worldTokens)}%`} title={`World notes: ${budget.worldTokens}`}></div>
              <div class="bg-accent" style={`width: ${pct(budget.characterTokens)}%`} title={`Characters: ${budget.characterTokens}`}></div>
              <div class="bg-info" style={`width: ${pct(budget.storyTokens)}%`} title={`Story tail: ${budget.storyTokens}${budget.storyTrimmed ? ' (trimmed)' : ''}`}></div>
              <div class="bg-neutral/30" style={`width: ${pct(budget.reserveTokens)}%`} title={`Reserve for output: ${budget.reserveTokens}`}></div>
            </div>
            <ul class="mt-2 space-y-1 text-xs">
              <li class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-full bg-primary"></span>System prompt<span class="ml-auto tabular-nums opacity-70">{budget.systemTokens}</span></li>
              <li class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-full bg-secondary"></span>World notes<span class="ml-auto tabular-nums opacity-70">{budget.worldTokens}</span></li>
              <li class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-full bg-accent"></span>Characters<span class="ml-auto tabular-nums opacity-70">{budget.characterTokens}</span></li>
              <li class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-full bg-info"></span>Story tail{budget.storyTrimmed ? ' (trimmed)' : ''}<span class="ml-auto tabular-nums opacity-70">{budget.storyTokens}</span></li>
              <li class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-full bg-neutral/30"></span>Output reserve<span class="ml-auto tabular-nums opacity-70">{budget.reserveTokens}</span></li>
            </ul>
          </div>
        {/if}

        <p class="text-[11px] leading-relaxed opacity-50">
          Estimates use ~4 characters per token; the server's reported usage (when available) is shown in the status bar.
          When context is tight, the story tail is trimmed first — system prompt and world data are kept intact.
        </p>
      </div>
    {:else}
      <p class="py-6 text-center text-sm opacity-50">Open a story to see its context budget.</p>
    {/if}

    <div class="modal-action mt-3 shrink-0">
      <button class="btn" title="Close" onclick={onClose}>Close</button>
    </div>
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <form method="dialog" class="modal-backdrop" onclick={onClose}><button>close</button></form>
</dialog>