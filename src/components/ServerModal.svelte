<script lang="ts">
  import type { ModelInfo, ServerProfile } from "../lib/types";
  import { listModels } from "../lib/llm";

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
    open: boolean;
    onClose: () => void;
    profiles: ServerProfile[];
    activeProfileId: string | null;
    models: ModelInfo[];
    onSelect: (id: string) => void;
    onAdd: () => void;
    onDelete: (p: ServerProfile) => void;
    onRefreshModels: () => void;
  } = $props();

  const profile = $derived(
    profiles.find((p) => p.id === activeProfileId) ?? null,
  );

  let modelOpen = $state(false);
  /**
   * Free-text filter for the suggestion list, kept separate from profile.modelId so opening
   * the dropdown shows every model — not just ones matching the current selection.
   */
  let modelQuery = $state("");
  const filteredModels = $derived(
    profile
      ? models.filter((m) =>
          m.id.toLowerCase().includes(modelQuery.trim().toLowerCase()),
        )
      : [],
  );

  /** Rows rendered at once — OpenRouter-style catalogs can hold hundreds of models. */
  const MODEL_PAGE = 50;
  let modelListEl: HTMLUListElement | undefined = $state();
  let modelInputEl: HTMLInputElement | undefined = $state();
  let boxEl: HTMLDivElement | undefined = $state();
  /**
   * Opening direction + list max-height (px), measured on every open. The dropdown is
   * absolutely positioned, so if it extends past .modal-box's padding box the box grows a
   * scrollbar of its own — and clicking that outer scrollbar is an "outside" pointerdown
   * that closes the dropdown (making the bottom of long lists unreachable). Fitting the
   * list into the larger free space above/below the input keeps it inside the box, so no
   * outer scrollbar can appear.
   */
  const DROPDOWN_MAX_H = 224; // was max-h-56
  const DROPDOWN_MIN_H = 120;
  let dropUp = $state(false);
  let listMaxH = $state(DROPDOWN_MAX_H);

  function fitDropdown() {
    const input = modelInputEl;
    if (!input || !boxEl) return;
    const i = input.getBoundingClientRect();
    const b = boxEl.getBoundingClientRect();
    const pad = 24; // .modal-box padding (1.5rem)
    const reserve = 36; // "Showing first N of M" footer + margins/borders
    const below = b.bottom - pad - i.bottom - reserve;
    const above = i.top - (b.top + pad) - reserve;
    dropUp = above > below;
    listMaxH = Math.min(
      DROPDOWN_MAX_H,
      Math.max(DROPDOWN_MIN_H, dropUp ? above : below),
    );
  }
  /** Keyboard-highlighted row (ArrowUp/Down + Enter); -1 = none. */
  let activeIdx = $state(-1);
  const visibleModels = $derived(filteredModels.slice(0, MODEL_PAGE));

  function pickModel(id: string) {
    if (!profile) return;
    setField("modelId", id);
    modelQuery = "";
    modelOpen = false;
  }

  function scrollActiveIntoView() {
    modelListEl
      ?.querySelector("[data-active]")
      ?.scrollIntoView({ block: "nearest" });
  }

  function onModelKeydown(e: KeyboardEvent) {
    if (!modelOpen || !visibleModels.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % visibleModels.length;
      scrollActiveIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + visibleModels.length) % visibleModels.length;
      scrollActiveIntoView();
    } else if (e.key === "Enter" && activeIdx >= 0) {
      const m = visibleModels[activeIdx];
      if (m) {
        e.preventDefault();
        pickModel(m.id);
      }
    } else if (e.key === "Escape") {
      modelOpen = false;
    }
  }

  // Close on a press anywhere outside the combobox. (The old blur-based close fired as soon
  // as a mousedown on a row or the list scrollbar moved focus away from the input — which is
  // exactly what killed "click to scroll" on long lists.)
  $effect(() => {
    if (!modelOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (
        !(e.target instanceof Element) ||
        !e.target.closest("[data-model-combo]")
      )
        modelOpen = false;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  });

  // Closing the dialog also closes the dropdown (and resets it for the next opening).
  $effect(() => {
    if (!open) {
      modelOpen = false;
      activeIdx = -1;
    }
  });

  let test = $state<{
    status: "idle" | "busy" | "ok" | "err";
    message: string;
  }>({ status: "idle", message: "" });

  let dlg: HTMLDialogElement | undefined = $state();
  $effect(() => {
    // showModal()/close() (not the `open` property) so the dialog is truly modal:
    // top layer, focus containment, and Escape closes it natively.
    if (dlg && dlg.open !== open) open ? dlg.showModal() : dlg.close();
  });

  async function testConnection() {
    if (!profile || !profile.baseUrl) return;
    test = { status: "busy", message: "Connecting…" };
    try {
      const ms = await listModels(profile.baseUrl, profile.apiKey);
      test = {
        status: "ok",
        message: `${ms.length} model${ms.length === 1 ? "" : "s"} found`,
      };
    } catch (e) {
      test = {
        status: "err",
        message: (e as Error).message || "Connection failed",
      };
    }
  }

  function setField<K extends keyof ServerProfile>(
    key: K,
    value: ServerProfile[K],
  ) {
    if (!profile) return;
    (profile as unknown as Record<string, unknown>)[key] = value;
  }
</script>

<dialog class="modal" bind:this={dlg} onclose={onClose}>
  <div class="modal-box w-full max-w-2xl" bind:this={boxEl}>
    <div class="mb-3 flex items-center justify-between">
      <h3 class="text-lg font-semibold">
        <i class="fa-solid fa-server mr-2 text-primary"></i>Servers &amp; models
      </h3>
      <button class="btn btn-ghost btn-sm" title="Close (Esc)" onclick={onClose}
        ><i class="fa-solid fa-xmark"></i></button
      >
    </div>

    <p class="mb-2 text-xs opacity-60">
      Any OpenAI-compatible endpoint works (Ollama, LM Studio, vLLM, llama.cpp
      server…). The base URL is the root of the
      <code class="rounded bg-base-300 px-1">/v1</code> API.
    </p>

    <div class="mb-4 max-h-48 space-y-1.5 overflow-y-auto pr-1">
      {#each profiles as p (p.id)}
        {@const active = p.id === activeProfileId}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 transition-colors ${active ? "border-primary bg-primary/10" : "border-base-300 hover:bg-base-200"}`}
          onclick={() => onSelect(p.id)}
        >
          <i
            class={`fa-solid ${active ? "fa-circle-dot text-primary" : "fa-circle opacity-40"}`}
          ></i>
          <div class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{p.name}</span>
            <span class="block truncate text-xs opacity-60"
              >{p.baseUrl || "no URL"}{p.modelId ? ` → ${p.modelId}` : ""}</span
            >
          </div>
          <button
            class="btn btn-ghost btn-xs text-error hover:bg-error/10"
            title="Delete profile"
            onclick={(e) => {
              e.stopPropagation();
              onDelete(p);
            }}
          >
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      {:else}
        <p
          class="rounded-xl border border-dashed border-base-300 px-3 py-4 text-center text-xs opacity-50"
        >
          No server profiles yet.
        </p>
      {/each}
    </div>
    <div class="rounded-xl border border-base-300 bg-base-200/50 p-3">
      <div class="mb-2 flex items-center justify-between">
        <h4 class="text-sm font-semibold">
          {profile ? `Editing: ${profile.name}` : "New profile"}
        </h4>
        <button
          class="btn btn-ghost btn-xs"
          title="Create a new profile"
          onclick={onAdd}><i class="fa-solid fa-plus"></i></button
        >
      </div>

      {#if profile}
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label class="form-control text-xs opacity-70"
            >Name
            <input
              class="input input-bordered input-sm mt-1"
              value={profile.name}
              placeholder="Local Ollama"
              oninput={(e) =>
                setField("name", (e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="form-control text-xs opacity-70"
            >Base URL
            <div class="input input-bordered input-sm mt-1">
              <input
                class="grow"
                value={profile.baseUrl}
                placeholder="http://127.0.0.1:8888"
                oninput={(e) =>
                  setField("baseUrl", (e.target as HTMLInputElement).value)}
              />
              <span>/v1</span>
            </div>
          </label>
          <label class="form-control text-xs opacity-70"
            >API key (optional)
            <input
              type="password"
              class="input input-bordered input-sm mt-1"
              value={profile.apiKey}
              placeholder="leave empty for local servers"
              oninput={(e) =>
                setField("apiKey", (e.target as HTMLInputElement).value)}
            />
          </label>
          <!-- z-10 on the label (not an opaque/opacity-dimmed wrapper) so the z-20 dropdown
               stacks above later siblings without creating a dimming stacking context -->
          <label class="relative z-10 form-control text-xs" data-model-combo>
            <span class="opacity-70">Model ID</span>
            <div class="relative mt-1">
              <input
                class="input input-bordered input-sm w-full"
                value={profile.modelId}
                placeholder="pick or type a model id"
                bind:this={modelInputEl}
                oninput={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  modelQuery = v;
                  activeIdx = -1;
                  setField("modelId", v);
                }}
                onfocus={() => {
                  modelOpen = true;
                  modelQuery = "";
                  activeIdx = -1;
                  fitDropdown();
                }}
                onkeydown={onModelKeydown}
              />
              {#if modelOpen && models.length > 0}
                <div
                  class={`absolute left-0 right-0 z-20 overflow-hidden rounded-box border border-base-300 bg-base-100 shadow-lg ${dropUp ? "bottom-full mb-1" : "top-full mt-1"}`}
                >
                  <ul
                    class="overflow-y-auto p-1"
                    style={`max-height:${listMaxH}px`}
                    bind:this={modelListEl}
                  >
                    {#each visibleModels as m, i (m.id)}
                      {@const selected = m.id === profile.modelId}
                      <li>
                        <button
                          type="button"
                          data-active={i === activeIdx ? "" : undefined}
                          class={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${i === activeIdx ? "bg-base-300" : selected ? "bg-primary/10 font-medium hover:bg-base-200" : "hover:bg-base-200"}`}
                          title={m.id}
                          onmouseenter={() => (activeIdx = i)}
                          onclick={() => pickModel(m.id)}
                        >
                          <span class="truncate">{m.id}</span>
                          {#if m.contextLength}<span
                              class="ml-auto shrink-0 text-[10px] opacity-50"
                              >{Math.round(m.contextLength / 1000)}k</span
                            >{/if}
                        </button>
                      </li>
                    {:else}
                      <li class="px-2 py-2 text-xs opacity-70">
                        No matching models — keep typing, or refresh the list.
                      </li>
                    {/each}
                  </ul>
                  {#if filteredModels.length > MODEL_PAGE}
                    <div
                      class="border-t border-base-300 px-2 py-1 text-[11px] opacity-60"
                    >
                      Showing first {MODEL_PAGE} of {filteredModels.length} — keep
                      typing to narrow
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          </label>
          <label class="form-control text-xs opacity-70"
            >Temperature
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              class="input input-bordered input-sm mt-1"
              value={profile.params.temperature}
              onchange={(e) => {
                if (profile)
                  profile.params.temperature = Number(
                    (e.target as HTMLInputElement).value,
                  );
              }}
            />
          </label>
          <label class="form-control text-xs opacity-70"
            >Max tokens (hard cap · 0 = reply length slider)
            <input
              type="number"
              min={0}
              step={64}
              class="input input-bordered input-sm mt-1"
              value={profile.params.maxTokens}
              onchange={(e) => {
                if (profile)
                  profile.params.maxTokens = Number(
                    (e.target as HTMLInputElement).value,
                  );
              }}
            />
          </label>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button
            class="btn btn-sm"
            title="Test the endpoint and refresh the model list"
            disabled={test.status === "busy"}
            onclick={testConnection}
          >
            {#if test.status === "busy"}<i class="fa-solid fa-spinner fa-spin"
              ></i>{:else}<i class="fa-solid fa-plug-circle-check"></i>{/if}
            Test connection
          </button>
          <button
            class="btn btn-ghost btn-sm"
            title="Refresh model list only"
            onclick={onRefreshModels}
          >
            <i class="fa-solid fa-rotate"></i> Refresh models
          </button>
          {#if test.status === "ok"}<span class="text-xs text-success"
              ><i class="fa-solid fa-check mr-1"></i>{test.message}</span
            >{/if}
          {#if test.status === "err"}<span
              class="text-xs text-error"
              title={test.message}
              ><i class="fa-solid fa-triangle-exclamation mr-1"
              ></i>{test.message}</span
            >{/if}
        </div>
      {:else}
        <p class="py-2 text-center text-xs opacity-50">
          Create a profile to get started.
        </p>
      {/if}
    </div>

    <div class="modal-action">
      <button class="btn" onclick={onClose}>Done</button>
    </div>
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <form method="dialog" class="modal-backdrop" onclick={onClose}>
    <button type="submit" aria-label="Close"></button>
  </form>
</dialog>
