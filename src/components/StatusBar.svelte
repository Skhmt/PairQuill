<script lang="ts">
import type { BudgetBreakdown, GenStats, ModelInfo, ServerProfile } from '../lib/types'

let {
  words,
  budget,
  maxContext,
  exceedsModel,
  genStats,
  profiles,
  activeProfile,
  models,
  onSelectProfile,
  onSelectModel,
  onRefreshModels,
  onOpenServers,
  onShowContext,
}: {
  words: number
  budget: BudgetBreakdown | null
  maxContext: number
  exceedsModel: boolean
  genStats: GenStats
  profiles: ServerProfile[]
  activeProfile: ServerProfile | null
  models: ModelInfo[]
  onSelectProfile: (id: string) => void
  onSelectModel: (id: string) => void
  onRefreshModels: () => void
  onOpenServers: () => void
  onShowContext: () => void
} = $props()

/** Prompt tokens currently in use (system + world + characters + story). null = nothing to measure. */
const contextUsed = $derived(
  budget ? budget.systemTokens + budget.worldTokens + budget.characterTokens + budget.storyTokens : null,
)
const contextPct = $derived(contextUsed !== null && maxContext > 0 ? Math.min(100, (contextUsed / maxContext) * 100) : 0)
const modelLoading = $derived(models.length === 0 && !!activeProfile?.baseUrl)
const modelTitle = $derived(activeProfile?.modelId ? `Model: ${activeProfile.modelId}` : 'Model')

/** Shorten a model label for the narrow status-bar select (native selects clip without an ellipsis). */
function shortModel(m: ModelInfo): string {
  const ctx = m.contextLength ? ` (${Math.round(m.contextLength / 1000)}k)` : ''
  const budget = 28 - ctx.length
  if (m.id.length <= budget) return m.id + ctx
  const cut = m.id.slice(0, Math.max(budget, 4))
  const sep = Math.max(cut.lastIndexOf('/'), cut.lastIndexOf('-'))
  const name = sep > budget * 0.5 ? cut.slice(0, sep) : cut
  return `${name}…${ctx}`
}
</script>

<!-- flex-wrap: on narrow windows the groups drop to a second line instead of squashing/overlapping -->
<footer class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-base-300 bg-base-100 px-3 py-1 text-xs">
  <span class="flex shrink-0 items-center gap-1.5 whitespace-nowrap" title="Word count"><i class="fa-solid fa-font opacity-60"></i>{words} words</span>

  <button
    class="btn btn-ghost h-auto min-h-0 cursor-pointer items-center gap-2 px-1 py-0.5 text-xs"
    title={exceedsModel
      ? "Context usage — warning: this story's context override exceeds the model's reported context length"
      : 'Context usage (prompt tokens / context window) — click for prompt budget details'}
    onclick={onShowContext}
  >
    <i class="fa-solid fa-gauge-high opacity-60"></i>
    <span class="tabular-nums">{contextUsed === null ? '—' : contextUsed.toLocaleString()}</span>
    <div class="h-1.5 w-24 overflow-hidden rounded-full bg-base-300">
      <div
        class={`h-full rounded-full transition-all ${contextPct >= 90 ? 'bg-error' : contextPct >= 70 ? 'bg-warning' : 'bg-primary'}`}
        style={`width: ${contextPct}%`}
      ></div>
    </div>
    {#if exceedsModel}
      <i class="fa-solid fa-triangle-exclamation text-warning" title="Context override exceeds the model's reported context length"></i>
    {/if}
    <span class={`tabular-nums ${exceedsModel ? 'font-semibold text-warning' : 'opacity-60'}`}>{maxContext.toLocaleString()}</span>
  </button>

  <span class="ml-auto flex shrink-0 items-center gap-2">
    {#if genStats.active}
      <span class="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-primary">
        <i class="fa-solid fa-spinner fa-spin"></i>
        in&nbsp;{genStats.promptTokens || '…'} · out&nbsp;{genStats.completionTokens}&nbsp;tokens
      </span>
    {/if}

    <select
      class="select select-bordered select-xs w-28 shrink-0 sm:w-36"
      value={activeProfile?.id ?? ''}
      onchange={(e) => onSelectProfile((e.target as HTMLSelectElement).value)}
      title="Server profile"
    >
      {#if !profiles.length}<option value="" disabled selected>no server</option>{/if}
      {#each profiles as p (p.id)}
        <option value={p.id}>{p.name}</option>
      {/each}
    </select>

    <div class="flex shrink-0 items-center gap-1">
      <select
        class="select select-bordered select-xs w-40 shrink-0 sm:w-52"
        value={activeProfile?.modelId ?? ''}
        onchange={(e) => onSelectModel((e.target as HTMLSelectElement).value)}
        title={modelTitle}
        disabled={!models.length && !activeProfile?.baseUrl}
      >
        <option value="" disabled selected={!models.length}>
          {modelLoading ? 'loading models…' : 'no model'}
        </option>
        {#each models as m (m.id)}
          <option value={m.id} title={m.id}>{shortModel(m)}</option>
        {/each}
      </select>
      <button class="btn btn-ghost btn-xs shrink-0" title="Refresh model list" onclick={onRefreshModels}>
        <i class="fa-solid fa-rotate"></i>
      </button>
    </div>

    <button class="btn btn-ghost btn-xs shrink-0" title="Server & model settings" onclick={onOpenServers}>
      <i class="fa-solid fa-gear"></i>
    </button>
  </span>
</footer>
