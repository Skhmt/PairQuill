<script lang="ts">
  import { RATING_LEVELS, THEMES, clampRating } from "../lib/types";
  import type {
    ContentRating,
    GenStats,
    OpKind,
    ThemeName,
  } from "../lib/types";
  import { OP_LABELS } from "../lib/prompts";

  let {
    theme,
    hasDoc,
    selection,
    retryAvailable,
    genStats,
    fontSize,
    measure,
    fontFamily,
    onSetTheme,
    onOpenShortcuts,
    onOpenAbout,
    onImportFile,
    onSaveAll,
    onSaveCurrent,
    onExportTxt,
    onOpenStories,
    onOpenWorld,
    onSetFontSize,
    onSetMeasure,
    onSetFont,
    onRunOp,
    onOpenCustom,
    onOpenInstruct,
    onStop,
    replyLength,
    onSetReplyLength,
    rating,
    onSetRating,
  }: {
    theme: ThemeName;
    hasDoc: boolean;
    /** Live selection state from the editor (word count for the "N words selected" hint). */
    selection: { has: boolean; words: number };
    /** True once the active doc has a generation Retry can re-send. */
    retryAvailable: boolean;
    genStats: GenStats;
    fontSize: "sm" | "md" | "lg";
    measure: "narrow" | "normal" | "wide";
    fontFamily: "serif" | "sans" | "mono";
    onSetTheme: (t: ThemeName) => void;
    onOpenShortcuts: () => void;
    /** Open the About dialog (version + GitHub link). */
    onOpenAbout: () => void;
    onImportFile: (file: File) => void;
    onSaveAll: () => void;
    /** Save the current story as a single-story .json project file. */
    onSaveCurrent: () => void;
    /** Export the current story's text as .txt. */
    onExportTxt: () => void;
    onOpenStories: () => void;
    onOpenWorld: () => void;
    onSetFontSize: (s: "sm" | "md" | "lg") => void;
    onSetMeasure: (m: "narrow" | "normal" | "wide") => void;
    onSetFont: (f: "serif" | "sans" | "mono") => void;
    /** Dispatch a one-shot op command to the active editor. */
    onRunOp: (op: OpKind) => void;
    onOpenCustom: () => void;
    onOpenInstruct: () => void;
    onStop: () => void;
    /** Reply-length setting in tokens (Generation section in the menu). */
    replyLength: number;
    onSetReplyLength: (tokens: number) => void;
    /** Content rating for generated prose (Generation section in the menu). */
    rating: ContentRating;
    onSetRating: (rating: ContentRating) => void;
  } = $props();

  let menuOpen = $state(false);
  let fileInput: HTMLInputElement | null = $state(null);

  function pickImport() {
    menuOpen = false;
    fileInput?.click();
  }

  $effect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: PointerEvent) {
      // Close when clicking anywhere outside the menu (capture phase so it wins over item clicks).
      if (
        !(e.target instanceof Element) ||
        !e.target.closest("[data-topbar-menu]")
      )
        menuOpen = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") menuOpen = false;
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  });

  /** Always-visible selection operations (icon buttons next to Continue). */
  const OPS: { kind: OpKind; icon: string; tip: string }[] = [
    {
      kind: "expand",
      icon: "fa-up-right-and-down-left-from-center",
      tip: "Expand the selection with more detail and description · Ctrl+Shift+E",
    },
    {
      kind: "condense",
      icon: "fa-compress",
      tip: "Condense the selection, keeping only the essentials · Ctrl+Shift+C",
    },
    {
      kind: "grammar",
      icon: "fa-spell-check",
      tip: "Fix grammar, spelling and punctuation in the selection · Ctrl+Shift+G",
    },
  ];

  const ITEM =
    "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-base-300 disabled:pointer-events-none disabled:opacity-40";
  /** One option of a segmented control inside a menu row (text size / line length). */
  const SEG = "px-2 py-0.5 leading-tight";
  /** Display label for a theme id ("caramellatte" -> "Caramellatte"). */
  const themeLabel = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

  // ---------- reply-length slider (log scale: 2^7 … 2^14 tokens) ----------
  const REPLY_MIN_EXP = 7; // 128 tokens — a few sentences
  const REPLY_MAX_EXP = 14; // 16384 tokens — ~16 pages of prose
  const REPLY_LABELS: Record<number, string> = {
    128: "a few sentences",
    256: "a paragraph",
    512: "a few paragraphs",
    1024: "~1 page",
    2048: "~2 pages",
    4096: "~4 pages",
    8192: "~8 pages",
    16384: "~16 pages",
  };
  /** Nearest slider step for the current setting (every saved value is a power of two). */
  const replyExp = $derived(
    Math.min(
      REPLY_MAX_EXP,
      Math.max(REPLY_MIN_EXP, Math.round(Math.log2(replyLength))),
    ),
  );
  const replyTokens = $derived(2 ** replyExp);
  const replyLabel = $derived(
    REPLY_LABELS[replyTokens] ??
      `${Math.round(replyLength).toLocaleString()} tokens`,
  );

  // ---------- content-rating slider (0 = safe, 1 = suggestive, 2 = explicit) ----------
  /** Live label for the selected rating stop. */
  const ratingLabel = $derived(
    RATING_LEVELS.find((r) => r.id === clampRating(rating))?.label ?? "SFW",
  );
</script>

<!-- min-h + flex-wrap (not a fixed h) so narrow viewports wrap to a second row instead of clipping controls. -->
<header
  class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-1.5"
>
  <div class="relative" data-topbar-menu>
    <button
      class="btn btn-ghost btn-sm"
      title="Menu"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onclick={() => (menuOpen = !menuOpen)}
    >
      <i class="fa-solid fa-bars"></i>
    </button>
    {#if menuOpen}
      <div
        role="menu"
        class="absolute left-0 top-full z-50 mt-1 max-h-[calc(100dvh-4rem)] w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-base-300 bg-base-200 py-1 shadow-lg"
      >
        <button
          role="menuitem"
          class={ITEM}
          onclick={() => {
            menuOpen = false;
            onOpenStories();
          }}
        >
          <i class="fa-solid fa-book-open w-4 text-center"></i>
          <span>Stories</span>
        </button>
        <button
          role="menuitem"
          class={ITEM}
          disabled={!hasDoc}
          onclick={() => {
            menuOpen = false;
            onOpenWorld();
          }}
        >
          <i class="fa-solid fa-globe w-4 text-center"></i>
          <span>World</span>
        </button>

        {#if hasDoc}
          <div class="my-1 border-t border-base-300"></div>
          <span
            class="block px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider opacity-40"
            >Generation</span
          >
          <label class="block px-3 py-1.5">
            <span class="flex items-center justify-between gap-2 text-sm">
              <span class="flex shrink-0 items-center gap-2.5 whitespace-nowrap"
                ><i class="fa-solid fa-gauge-high w-4 text-center opacity-70"
                ></i>Content rating</span
              >
              <span class="whitespace-nowrap text-xs opacity-60">{ratingLabel}</span>
            </span>
            <input
              type="range"
              min={0}
              max={2}
              step={1}
              value={rating}
              oninput={(e) =>
                onSetRating(
                  clampRating(Number((e.target as HTMLInputElement).value)),
                )}
              class="mt-1 range range-primary range-xs w-full"
              aria-label="Content rating"
            />
          </label>
          <label class="block px-3 py-1.5">
            <span class="flex items-center justify-between gap-2 text-sm">
              <span class="flex shrink-0 items-center gap-2.5 whitespace-nowrap"
                ><i
                  class="fa-solid fa-ruler-horizontal w-4 text-center opacity-70"
                ></i>Reply length</span
              >
              <span class="whitespace-nowrap text-xs tabular-nums opacity-60"
                >{replyTokens.toLocaleString()} tokens · {replyLabel}</span
              >
            </span>
            <input
              type="range"
              min={REPLY_MIN_EXP}
              max={REPLY_MAX_EXP}
              step={1}
              value={replyExp}
              oninput={(e) =>
                onSetReplyLength(
                  2 ** Number((e.target as HTMLInputElement).value),
                )}
              class="mt-1 range range-primary range-xs w-full"
              aria-label="Reply length"
            />
          </label>
        {/if}

        <div class="my-1 border-t border-base-300"></div>

        <!-- Text styling (moved here from the editor action bar) -->
        <div
          class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
        >
          <span class="flex shrink-0 items-center gap-2.5">
            <i class="fa-solid fa-text-height w-4 text-center"></i>Text size
          </span>
          <div
            class="flex overflow-hidden rounded-md border border-base-300"
            role="group"
            aria-label="Text size"
          >
            <button
              class={`${SEG} text-xs ${fontSize === "sm" ? "bg-primary text-primary-content" : "hover:bg-base-300"}`}
              title="Small text"
              onclick={() => onSetFontSize("sm")}
            >
              A
            </button>
            <button
              class={`${SEG} text-sm ${fontSize === "md" ? "bg-primary text-primary-content" : "hover:bg-base-300"}`}
              title="Medium text"
              onclick={() => onSetFontSize("md")}
            >
              A
            </button>
            <button
              class={`${SEG} text-base ${fontSize === "lg" ? "bg-primary text-primary-content" : "hover:bg-base-300"}`}
              title="Large text"
              onclick={() => onSetFontSize("lg")}
            >
              A
            </button>
          </div>
        </div>
        <div
          class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
        >
          <span class="flex shrink-0 items-center gap-2.5">
            <i class="fa-solid fa-text-width w-4 text-center"></i>Line length
          </span>
          <div
            class="flex overflow-hidden rounded-md border border-base-300"
            role="group"
            aria-label="Line length"
          >
            <button
              class={`px-1.5 py-1 ${measure === "narrow" ? "bg-primary text-primary-content" : "hover:bg-base-300"}`}
              title="Narrow line length"
              onclick={() => onSetMeasure("narrow")}
            >
              <svg viewBox="0 0 14 10" class="h-2.5 w-3.5 fill-current"
                ><rect x="1" y="2" width="7" height="2" rx="1" /><rect
                  x="1"
                  y="6"
                  width="5"
                  height="2"
                  rx="1"
                /></svg
              >
            </button>
            <button
              class={`px-1.5 py-1 ${measure === "normal" ? "bg-primary text-primary-content" : "hover:bg-base-300"}`}
              title="Normal line length"
              onclick={() => onSetMeasure("normal")}
            >
              <svg viewBox="0 0 14 10" class="h-2.5 w-3.5 fill-current"
                ><rect x="1" y="2" width="11" height="2" rx="1" /><rect
                  x="1"
                  y="6"
                  width="8"
                  height="2"
                  rx="1"
                /></svg
              >
            </button>
            <button
              class={`px-1.5 py-1 ${measure === "wide" ? "bg-primary text-primary-content" : "hover:bg-base-300"}`}
              title="Wide line length"
              onclick={() => onSetMeasure("wide")}
            >
              <svg viewBox="0 0 14 10" class="h-2.5 w-3.5 fill-current"
                ><rect x="1" y="2" width="13" height="2" rx="1" /><rect
                  x="1"
                  y="6"
                  width="10"
                  height="2"
                  rx="1"
                /></svg
              >
            </button>
          </div>
        </div>
        <div
          class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
        >
          <span class="flex shrink-0 items-center gap-2.5">
            <i class="fa-solid fa-font w-4 text-center"></i>Font
          </span>
          <select
            class="select select-bordered select-sm w-auto"
            value={fontFamily}
            onchange={(e) =>
              onSetFont(
                (e.target as HTMLSelectElement).value as
                  | "serif"
                  | "sans"
                  | "mono",
              )}
            title="Editor font"
          >
            <option value="serif">Serif</option>
            <option value="sans">Sans</option>
            <option value="mono">Mono</option>
          </select>
        </div>
        <div
          class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
        >
          <span class="flex shrink-0 items-center gap-2.5">
            <i class="fa-solid fa-palette w-4 text-center"></i>Theme
          </span>
          <select
            class="select select-bordered select-sm w-auto"
            value={theme}
            onchange={(e) => {
              menuOpen = false;
              onSetTheme((e.target as HTMLSelectElement).value as ThemeName);
            }}
            title="DaisyUI theme"
          >
            {#each THEMES as t}
              <option value={t}>{themeLabel(t)}</option>
            {/each}
          </select>
        </div>

        <div class="my-1 border-t border-base-300"></div>

        <button
          role="menuitem"
          class={ITEM}
          onclick={() => {
            menuOpen = false;
            onOpenShortcuts();
          }}
        >
          <i class="fa-solid fa-keyboard w-4 text-center"></i>
          <span>Keyboard shortcuts</span>
          <kbd class="kbd kbd-sm ml-auto">F1</kbd>
        </button>
        <div class="my-1 border-t border-base-300"></div>
        <button role="menuitem" class={ITEM} onclick={pickImport}>
          <i class="fa-solid fa-file-import w-4 text-center"></i>
          <span>Import file…</span>
          <span class="ml-auto text-[11px] opacity-50">.txt / .json</span>
        </button>
        <button
          role="menuitem"
          class={ITEM}
          onclick={() => {
            menuOpen = false;
            onSaveAll();
          }}
        >
          <i class="fa-solid fa-box-archive w-4 text-center"></i>
          <span>Save all stories (.json)</span>
        </button>
        <button
          role="menuitem"
          class={ITEM}
          disabled={!hasDoc}
          onclick={() => {
            menuOpen = false;
            onSaveCurrent();
          }}
        >
          <i class="fa-solid fa-floppy-disk w-4 text-center"></i>
          <span>Save current story (.json)</span>
        </button>
        <button
          role="menuitem"
          class={ITEM}
          disabled={!hasDoc}
          onclick={() => {
            menuOpen = false;
            onExportTxt();
          }}
        >
          <i class="fa-solid fa-file-export w-4 text-center"></i>
          <span>Export current story (.txt)</span>
        </button>

        <div class="my-1 border-t border-base-300"></div>
        <button
          role="menuitem"
          class={ITEM}
          onclick={() => {
            menuOpen = false;
            onOpenAbout();
          }}
        >
          <i class="fa-solid fa-circle-info w-4 text-center"></i>
          <span>About PairQuill</span>
        </button>
      </div>
    {/if}
  </div>

  <!-- Brand icon drops out below sm so the generation controls always fit on one row. -->
  <span class="flex items-center gap-2 pr-1 max-sm:hidden" title="PairQuill">
    <i class="fa-solid fa-feather-pointed text-lg text-primary"></i>
    <span class="hidden font-semibold tracking-tight sm:inline">PairQuill</span>
  </span>

  <!-- Hidden picker shared by the menu's "Import file…" item -->
  <input
    bind:this={fileInput}
    type="file"
    accept=".txt,.md,.json,text/plain,application/json"
    class="hidden"
    onchange={(e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) onImportFile(f);
      (e.target as HTMLInputElement).value = "";
    }}
  />

  <span class="flex-1"></span>

  <!-- Generation controls (moved here from the editor action bar) -->
  {#if hasDoc}
    {#if selection.has && !genStats.active}
      <span class="hidden whitespace-nowrap text-xs opacity-50 lg:inline"
        >{selection.words} words selected</span
      >
      <span class="hidden h-5 w-px shrink-0 bg-base-300 lg:block"></span>
    {/if}

    <!-- Selection operations: always visible, disabled until a passage is selected -->
    <div
      class="flex items-center gap-1"
      role="toolbar"
      aria-label="Selection operations"
    >
      {#each OPS as op (op.kind)}
        <span data-tip={op.tip} data-tip-pos="down">
          <button
            class="btn btn-ghost btn-sm px-2"
            disabled={!selection.has || genStats.active}
            aria-label={OP_LABELS[op.kind]}
            onclick={() => onRunOp(op.kind)}
          >
            <i class={`fa-solid ${op.icon}`}></i>
          </button>
        </span>
      {/each}

      <span class="h-5 w-px shrink-0 bg-base-300"></span>

      <span
        data-tip="Give a custom instruction for the selection"
        data-tip-pos="down"
      >
        <button
          class="btn btn-ghost btn-sm px-2"
          disabled={!selection.has || genStats.active}
          aria-label="Custom instruction"
          onclick={onOpenCustom}
        >
          <i class="fa-solid fa-comment"></i>
        </button>
      </span>
    </div>

    {#if genStats.active}
      <span
        class="flex items-center gap-2 whitespace-nowrap text-xs text-primary"
      >
        <i class="fa-solid fa-spinner fa-spin"></i>
        {genStats.label ?? "Generating"}…
      </span>
      <button
        class="btn btn-error btn-sm"
        title="Stop generation"
        onclick={onStop}
      >
        <i class="fa-solid fa-stop"></i> Stop
      </button>
    {:else}
      <!-- Retry + Instruct: like Continue, they work without a selection -->
      <span
        data-tip={retryAvailable
          ? "Re-send the last request, replacing its output · Ctrl+Shift+Y"
          : "Generate something first to enable retry"}
        data-tip-pos="down"
        data-tip-align="end"
      >
        <button
          class="btn btn-ghost btn-sm px-2"
          disabled={!retryAvailable}
          aria-label="Retry"
          onclick={() => onRunOp("retry")}
        >
          <i class="fa-solid fa-rotate-right"></i>
        </button>
      </span>
      <span
        data-tip="Continue with custom instructions"
        data-tip-pos="down"
        data-tip-align="end"
      >
        <button
          class="btn btn-ghost btn-sm px-2"
          aria-label="Instruct"
          onclick={onOpenInstruct}
        >
          <i class="fa-solid fa-wand-magic-sparkles"></i>
        </button>
      </span>
      <span
        data-tip="Generate the next part of the story from the cursor · Ctrl+Enter"
        data-tip-pos="down"
        data-tip-align="end"
      >
        <button
          class="btn btn-primary btn-sm"
          onclick={() => onRunOp("continue")}
        >
          <i class="fa-solid fa-forward mr-1 max-sm:mr-0"></i><span
            class="max-sm:hidden">Continue</span
          >
        </button>
      </span>
    {/if}
  {/if}
</header>
