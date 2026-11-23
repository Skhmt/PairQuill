<script lang="ts">
import type { ModelInfo, ServerProfile } from '../lib/types'
import { listModels } from '../lib/llm'

let {
  open,
  onClose,
  profiles,
  activeProfileId,
  models,
  onSelect,
  onAdd,
  onDelete,
  onRefreshModels,
}: {
  open: boolean
  onClose: () => void
  profiles: ServerProfile[]
  activeProfileId: string | null
  models: ModelInfo[]
  onSelect: (id: string) => void
  onAdd: () => void
  onDelete: (p: ServerProfile) => void
  onRefreshModels: () => void
} = $props()

const profile = $derived(profiles.find((p) => p.id === activeProfileId) ?? null)

let modelOpen = $state(false)
/**
 * Free-text filter for the suggestion list, kept separate from profile.modelId so opening
 * the dropdown shows every model — not just ones matching the current selection.
 */
let modelQuery = $state('')
const filteredModels = $derived(
  profile ? models.filter((m) => m.id.toLowerCase().includes(modelQuery.trim().toLowerCase())) : [],
)

let test = $state<{ status: 'idle' | 'busy' | 'ok' | 'err'; message: string }>({ status: 'idle', message: '' })

let dlg: HTMLDialogElement | undefined = $state()
$effect(() => {
  // showModal()/close() (not the `open` property) so the dialog is truly modal:
  // top layer, focus containment, and Escape closes it natively.
  if (dlg && dlg.open !== open) (open ? dlg.showModal() : dlg.close())
})

async function testConnection() {
  if (!profile || !profile.baseUrl) return
  test = { status: 'busy', message: 'Connecting…' }
  try {
    const ms = await listModels(profile.baseUrl, profile.apiKey)
    test = { status: 'ok', message: `${ms.length} model${ms.length === 1 ? '' : 's'} found` }
  } catch (e) {
    test = { status: 'err', message: (e as Error).message || 'Connection failed' }
  }
}

function setField<K extends keyof ServerProfile>(key: K, value: ServerProfile[K]) {
  if (!profile) return
  ;(profile as unknown as Record<string, unknown>)[key] = value
}
</script>

<dialog class="modal" bind:this={dlg} onclose={onClose}>
  <div class="modal-box w-full max-w-2xl">
    <div class="mb-3 flex items-center justify-between">
      <h3 class="text-lg font-semibold"><i class="fa-solid fa-server mr-2 text-primary"></i>Servers &amp; models</h3>
      <button class="btn btn-ghost btn-sm" title="Close (Esc)" onclick={onClose}><i class="fa-solid fa-xmark"></i></button>
    </div>

    <p class="mb-2 text-xs opacity-60">
      Any OpenAI-compatible endpoint works (Ollama, LM Studio, vLLM, llama.cpp server…). The base URL is the root of the
      <code class="rounded bg-base-300 px-1">/v1</code> API.
    </p>

    <div class="mb-4 max-h-48 space-y-1.5 overflow-y-auto pr-1">
      {#each profiles as p (p.id)}
        {@const active = p.id === activeProfileId}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 transition-colors ${active ? 'border-primary bg-primary/10' : 'border-base-300 hover:bg-base-200'}`}
          onclick={() => onSelect(p.id)}
        >
          <i class={`fa-solid ${active ? 'fa-circle-dot text-primary' : 'fa-circle opacity-40'}`}></i>
          <div class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{p.name}</span>
            <span class="block truncate text-xs opacity-60">{p.baseUrl || 'no URL'}{p.modelId ? ` → ${p.modelId}` : ''}</span>
          </div>
          <button
            class="btn btn-ghost btn-xs text-error hover:bg-error/10"
            title="Delete profile"
            onclick={(e) => { e.stopPropagation(); onDelete(p) }}
          >
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      {:else}
        <p class="rounded-xl border border-dashed border-base-300 px-3 py-4 text-center text-xs opacity-50">No server profiles yet.</p>
      {/each}
    </div>
    <div class="rounded-xl border border-base-300 bg-base-200/50 p-3">
      <div class="mb-2 flex items-center justify-between">
        <h4 class="text-sm font-semibold">{profile ? `Editing: ${profile.name}` : 'New profile'}</h4>
        <button class="btn btn-ghost btn-xs" title="Create a new profile" onclick={onAdd}><i class="fa-solid fa-plus"></i></button>
      </div>

      {#if profile}
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label class="form-control text-xs opacity-70">Name
            <input class="input input-bordered input-sm mt-1" value={profile.name} placeholder="Local Ollama" oninput={(e) => setField('name', (e.target as HTMLInputElement).value)} />
          </label>
          <label class="form-control text-xs opacity-70">Base URL (/v1 root)
            <input class="input input-bordered input-sm mt-1" value={profile.baseUrl} placeholder="http://127.0.0.1:8888/v1" oninput={(e) => setField('baseUrl', (e.target as HTMLInputElement).value)} />
          </label>
          <label class="form-control text-xs opacity-70">API key (optional)
            <input type="password" class="input input-bordered input-sm mt-1" value={profile.apiKey} placeholder="leave empty for local servers" oninput={(e) => setField('apiKey', (e.target as HTMLInputElement).value)} />
          </label>
          <!-- z-10 + opacity moved to the caption span: an opaque/opacity-dimmed <label> would create a stacking context (trapping the z-20 dropdown under later siblings) and composite the whole popup at 70% alpha -->
          <label class="relative z-10 form-control text-xs">
            <span class="opacity-70">Model ID</span>
            <div class="relative mt-1">
              <input
                class="input input-bordered input-sm w-full"
                value={profile.modelId}
                placeholder="pick or type a model id"
                oninput={(e) => { const v = (e.target as HTMLInputElement).value; modelQuery = v; setField('modelId', v) }}
                onfocus={() => { modelOpen = true; modelQuery = '' }}
                onblur={() => (modelOpen = false)}
                onkeydown={(e) => { if (e.key === 'Escape') modelOpen = false }}
              />
              {#if modelOpen}
                {#if filteredModels.length}
                  <ul class="absolute left-0 right-0 top-full z-20 mt-1 max-h-40 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
                    {#each filteredModels as m (m.id)}
                      <li>
                        <button
                          type="button"
                          class={`block w-full truncate rounded px-2 py-1 text-left text-sm ${m.id === profile.modelId ? 'bg-primary/10 font-medium' : 'hover:bg-base-200'}`}
                          title={m.id}
                          onpointerdown={() => { setField('modelId', m.id); modelQuery = ''; modelOpen = false }}
                        >{m.id}{m.contextLength ? ` (${Math.round(m.contextLength / 1000)}k)` : ''}</button>
                      </li>
                    {/each}
                  </ul>
                {:else if models.length}
                  <div class="absolute left-0 right-0 top-full z-20 mt-1 rounded-box border border-base-300 bg-base-100 p-2 text-xs opacity-70 shadow-lg">
                    No matching models — keep typing, or refresh the list.
                  </div>
                {/if}
              {/if}
            </div>
          </label>
          <label class="form-control text-xs opacity-70">Temperature
            <input type="number" min={0} max={2} step={0.1} class="input input-bordered input-sm mt-1" value={profile.params.temperature} onchange={(e) => { if (profile) profile.params.temperature = Number((e.target as HTMLInputElement).value) }} />
          </label>
          <label class="form-control text-xs opacity-70">Max tokens (hard cap · 0 = reply length slider)
            <input type="number" min={0} step={64} class="input input-bordered input-sm mt-1" value={profile.params.maxTokens} onchange={(e) => { if (profile) profile.params.maxTokens = Number((e.target as HTMLInputElement).value) }} />
          </label>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button class="btn btn-sm" title="Test the endpoint and refresh the model list" disabled={test.status === 'busy'} onclick={testConnection}>
            {#if test.status === 'busy'}<i class="fa-solid fa-spinner fa-spin"></i>{:else}<i class="fa-solid fa-plug-circle-check"></i>{/if}
            Test connection
          </button>
          <button class="btn btn-ghost btn-sm" title="Refresh model list only" onclick={onRefreshModels}>
            <i class="fa-solid fa-rotate"></i> Refresh models
          </button>
          {#if test.status === 'ok'}<span class="text-xs text-success"><i class="fa-solid fa-check mr-1"></i>{test.message}</span>{/if}
          {#if test.status === 'err'}<span class="text-xs text-error" title={test.message}><i class="fa-solid fa-triangle-exclamation mr-1"></i>{test.message}</span>{/if}
        </div>
      {:else}
        <p class="py-2 text-center text-xs opacity-50">Create a profile to get started.</p>
      {/if}
    </div>

    <div class="modal-action">
      <button class="btn" onclick={onClose}>Done</button>
    </div>
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <form method="dialog" class="modal-backdrop" onclick={onClose}><button type="submit" aria-label="Close"></button></form>
</dialog>

