# PairQuill

A local-first AI co-writing studio for interactive fiction. Write your story, point it at any OpenAI-compatible model, and keep authorship in your own hands — everything is stored on your machine, and requests go directly from the page to the endpoint you choose.

## Features

- **Your data stays local.** Stories, world data, server profiles, and generation history live in the browser's IndexedDB (database `pairquill`). No accounts, no cloud; the only network traffic is between the page and your chosen model endpoint.
- **Multi-story workspace.** Create, rename, import, export, and delete stories from the Stories modal. Each story carries world notes, character profiles, and tone/style notes that are injected into every prompt.
- **Generation operations.** Continue from the cursor (`Ctrl+Enter`), continue with custom instructions (the Instruct dialog — works without a selection), retry the last generation (`Ctrl+Shift+Y`), or expand / condense / grammar-fix a highlighted passage, plus free-form custom instructions for a selection. Output streams live into the editor and AI-added text is highlighted until your next manual edit.
- **Content rating.** A three-stop slider (Safe / Suggestive / Explicit) in the top-bar menu; matching guidance is injected into every system prompt so all operations respect it.
- **Reply length control.** An exponential token slider for how long a reply may be, hard-capped by the profile's own max tokens, with a soft word-count hint when the cap is small enough to actually bite.
- **Context budget management.** Uses each model's context window (reported by `/models`), reserves room for the reply, and trims the story tail to fit. The Context modal shows a per-section breakdown and lets you override the limit manually.
- **Chapter mode.** A resizable outline sidebar with add / rename / drag-reorder / delete, per-chapter word counts, manual or AI-generated chapter summaries (injected as consistency context for non-current chapters), and Chapter vs. Full-story view modes. Generation targets only the active chapter.
- **Server profiles.** Multiple named OpenAI-compatible endpoints — curated presets (aggregators, frontier labs, local runtimes) or any custom base URL — with a searchable model list showing context lengths and a one-click connection test.
- **Portable projects.** Export any story as `.txt`; save the current story or the whole workspace as a `.json` project file; importing merges without overwriting local data.
- **Appearance.** Seven DaisyUI themes, plus text size, line length, and font (serif / sans / mono) choices in the top-bar menu.
- **Mobile-friendly.** The layout is responsive down to 320 px wide and audited by `scripts/mobile-audit.mjs`.

## Getting started

Prerequisites: a recent Node.js LTS (Vite 8 requires at least Node 20.19).

```bash
npm install
npm run dev
```

Then open the URL printed in the terminal (default `http://localhost:5173`). No environment variables or build step are needed for development.

`npm run build` produces a self-contained single-file `dist/index.html` (via `vite-plugin-singlefile`) that can be opened directly from disk — handy for trying the app without running a server.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server on all interfaces (`vite --host`). |
| `npm run build` | Production build → self-contained `dist/index.html`. |
| `npm run preview` | Serve the production build locally. |
| `npm run check` | Type-check with `svelte-check` + `tsc`. |
| `node scripts/verify-ui.mjs` | End-to-end UI verification against a self-contained mock OpenAI-compatible server (port 9877): top bar, Stories / World / Context modals, status bar, streaming generation, reply-length slider, and content-rating injection. |
| `node scripts/verify-chapters.mjs` | Chapter-support E2E (mock server on port 9879): legacy-doc compatibility, chaptering flow, persistence across reload, per-chapter generation, summaries, full-story view, and v1/v2 project import/export. |
| `node scripts/mobile-audit.mjs` | Mobile layout audit at 375×667, 360×800, and 320×568: top-bar clipping, status-bar wrapping + iOS zoom guard, server-modal fit, touch-visible actions, menu fit. |

The verification scripts load `dist/index.html`, so run `npm run build` first; they drive Microsoft Edge via Playwright (`playwright-core`, channel `msedge`).

## Server configuration

Open **Server & model settings** (gear icon in the status bar). The modal has a profile list on the left and an editor on the right (stacked into one column on narrow screens).

- **Presets.** `src/config/servers.json` ships curated endpoints grouped as *Aggregator*, *Frontier*, and *Local*, plus **Custom…** for anything else. Selecting a preset fills in the base URL and links to where you can get an API key when applicable.
- **Fields per profile:** name, base URL (any OpenAI-compatible `/v1` endpoint), API key (optional for local runtimes), temperature (0–2), and model ID — a searchable list fetched from `GET {base}/models`, showing each model's context length.
- **Test connection** hits the endpoint and refreshes the model list, reporting how many models were found or the error inline.
- Pick the active profile and model in the status bar; the refresh button re-fetches the model list.

### Prompt construction

Every request's system prompt is rendered from the profile's template (or a built-in default) with these placeholders:

| Placeholder | Content |
| --- | --- |
| `{world_notes}` | The story's world notes (`## title` sections) |
| `{characters}` | Character profiles (`### name` + description) |
| `{tone}` | Tone/style notes |
| `{rating}` | The content-rating guidance block (appended automatically if the template omits it) |
| `{chapters}` | "Story so far" summaries of non-current chapters (when chapter summaries are enabled) |

## Chapter workflow

1. **Enable chapters** from the top-bar menu — existing text becomes a single chapter (or start fresh).
2. Manage chapters in the outline sidebar: **New** adds one after the active chapter, click to select, double-click (or the pen icon) to rename, drag rows to reorder, and the trash icon deletes (deleting the last chapter converts the story back to plain single-document mode). The sidebar is collapsible and resizable (180–480 px).
3. Switch between **Chapter** and **Full story** views in the top bar — full-story view is read-only with separators; the "Ch. X of Y · Title" label and prev/next buttons navigate chapters.
4. **Summaries:** each chapter has a summary box in the outline — write it manually or click **Auto** for an AI 3–5 sentence summary. A stale warning appears if the chapter is edited after summarizing. Toggle whether summaries are sent to the model in the Context modal (*Include chapter summaries*); only non-current chapters with a summary are included.
5. **Generate:** Continue / Instruct operate on the active chapter only; the status bar shows chapter and total word counts.
6. **Disable chapters** from the menu merges everything back into one document — lossless.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Continue from cursor | `Ctrl+Enter` |
| Retry last generation | `Ctrl+Shift+Y` |
| Expand selection | `Ctrl+Shift+E` |
| Condense selection | `Ctrl+Shift+C` |
| Grammar-fix selection | `Ctrl+Shift+G` |
| Toggle chapters outline | `Ctrl+Shift+L` |
| Show shortcuts help | `F1` |
| Close a dialog or the menu | `Esc` |

On macOS, hold `⌘` instead of `Ctrl`. Selection operations (expand / condense / grammar / custom) require a highlighted passage.

## Mobile support

- The top bar and status bar wrap rather than clip; **Continue** stays reachable down to 320 px wide.
- Status-bar controls use ≥16 px fonts so iOS does not auto-zoom on focus.
- Chapter row actions (rename / delete) are always visible on touch devices — no hover required.
- The server settings modal collapses to a single column on narrow screens, and the hamburger menu fits the viewport.
- All of the above is covered by `scripts/mobile-audit.mjs` (375×667, 360×800, 320×568).

## Project structure

```
PairQuill/
├── index.html                  # app entry point
├── vite.config.ts              # Vite + Svelte + Tailwind v4 + single-file output
├── svelte.config.js
├── tsconfig*.json
├── src/
│   ├── main.ts                 # bootstrap
│   ├── app.css                 # Tailwind + DaisyUI theme setup
│   ├── App.svelte              # state, persistence, generation orchestration
│   ├── components/
│   │   ├── TopBar.svelte       # hamburger menu (Stories / World / chapters, rating & length sliders, appearance), chapter nav, generation controls
│   │   ├── EditorPane.svelte   # story/chapter textareas, selection ops, custom-instruction + instruct dialogs
│   │   ├── ChapterOutline.svelte  # outline sidebar: add / rename / reorder / delete, summaries
│   │   ├── StatusBar.svelte    # word count, context gauge, profile/model pickers, settings gear
│   │   ├── ServerModal.svelte  # server profiles: presets, endpoints, models, connection test
│   │   ├── ContextModal.svelte # context budget breakdown + manual override
│   │   ├── StoriesModal.svelte # story list: new / import / export / delete
│   │   ├── WorldModal.svelte   # world notes, characters, tone
│   │   ├── ShortcutsModal.svelte  # keyboard shortcuts reference (F1)
│   │   └── AboutModal.svelte   # about dialog
│   ├── config/
│   │   └── servers.json        # curated endpoint presets
│   └── lib/
│       ├── types.ts            # shared types (StoryDoc, ServerProfile, AppSettings, ...)
│       ├── idb.ts              # IndexedDB persistence (db "pairquill")
│       ├── llm.ts              # OpenAI-compatible client: /models + streaming chat completions
│       ├── prompts.ts          # system prompt templates, rating guidance, per-op messages
│       ├── tokens.ts           # token estimates and context budget computation
│       ├── chapters.ts         # chapter model: enable / add / rename / reorder / delete helpers
│       ├── project.ts          # .json project file build/parse (v1/v2 compatible)
│       └── format.ts           # word count, time-ago, and other formatting helpers
└── scripts/
    ├── verify-ui.mjs           # E2E UI verification (mock server :9877)
    ├── verify-chapters.mjs     # chapter-support E2E (mock server :9879)
    └── mobile-audit.mjs        # narrow-viewport layout audit
```

## License

MIT — see [LICENSE](LICENSE).
