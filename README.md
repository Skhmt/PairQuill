# PairQuill

A lightweight, distraction-free writing studio for collaborative storytelling with local and remote LLMs.

PairQuill is built for authors who want AI assistance without the chatbox. Instead of feeling like a roleplay chat or messaging thread, PairQuill functions as an ergonomic word processor: your manuscript is plain text, generations stream directly into the document at the cursor, and targeted editing tools let you expand, condense, or polish selected passages on the fly.

Everything runs entirely in your browser—offline-first, with zero telemetry and no accounts required.

---

## Highlights

* **Word-Processor Interaction**: Stream continuations right at your cursor, rewrite or expand selections, and edit seamlessly. AI additions are highlighted until your next edit so you always know what was written by the model.
* **Selection-Targeted Operations**: Highlight any sentence or paragraph to run instant actions:
  * **Expand**: Flesh out scenes with sensory detail and narrative depth.
  * **Condense**: Cut redundancy and tighten prose while preserving tone and key facts.
  * **Grammar**: Correct spelling and punctuation without altering authorial voice.
  * **Custom Instruction**: Prompt the model to rewrite the selected passage according to your exact requirements.
* **Worldbuilding & Story Bible**: Attach world lore, character cards, and tone/style guides to each story. These are dynamically injected into prompt templates so models maintain continuity.
* **Live Token & Budget Meter**: Visual gauge tracking prompt budget (system prompt, world notes, characters, story tail, and reserve tokens) against the active model's context window.
* **Universal OpenAI-Compatible Backend**: Connect out of the box to local inference engines (Ollama, LM Studio, llama.cpp, vLLM, KoboldCpp) or cloud endpoints (OpenRouter, Groq, OpenAI, etc.).
* **Content Rating Control**: A three-stop slider in the top bar (SFW → Romance/Softcore → Explicit/Hardcore) injects matching guidance into the system prompt of every generation request. The choice persists with your settings, and custom prompt templates can place it exactly where they want via a `{rating}` placeholder.
* **Offline-First & Local Storage**: Stories and configurations are persisted in browser IndexedDB (no 5MB localStorage limits), effortlessly handling manuscripts exceeding 200k+ words.
* **Single-File Distribution**: Builds into a self-contained single `.html` file that can be opened directly from disk or hosted on static hosts (GitHub Pages, Cloudflare Pages).
* **Full Data Sovereignty**: Export and import complete workspaces or single stories as `.json` project files, or export clean manuscripts as `.txt`.

---

## Keyboard Shortcuts

Designed for hands-on-keyboard writing sessions:

| Action | Shortcut (Windows / Linux) | Shortcut (macOS) | Description |
| :--- | :--- | :--- | :--- |
| **Continue** | <kbd>Ctrl</kbd> + <kbd>Enter</kbd> | <kbd>⌘</kbd> + <kbd>Enter</kbd> | Stream generation from cursor position |
| **Retry** | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Y</kbd> | <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>Y</kbd> | Re-send last generation, replacing its output |
| **Expand** | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>E</kbd> | <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>E</kbd> | Expand selected text with richer detail |
| **Condense** | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>C</kbd> | <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>C</kbd> | Condense selected text |
| **Grammar Fix** | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>G</kbd> | <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>G</kbd> | Fix grammar, punctuation, and typos |
| **Help** | <kbd>F1</kbd> | <kbd>F1</kbd> | Open keyboard shortcuts reference |
| **Close / Dismiss** | <kbd>Esc</kbd> | <kbd>Esc</kbd> | Close active modal dialog or menu |

---

## Quick Start

### Prerequisites

* [Node.js](https://nodejs.org/) (v20.19+ or v22.12+ — required by Vite 8)
* [npm](https://www.npmjs.com/) (bundled with Node.js)

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/skhmt/pairquill.git
cd pairquill
npm install
```

### Development Server

Start Vite's development server:

```bash
npm run dev
```

Open the displayed localhost URL in your browser (typically `http://localhost:5173`).

### Production Build

Compile the application into a single self-contained HTML file:

```bash
npm run build
```

The output bundle is generated at `dist/index.html`. You can double-click this file to run PairQuill locally in any modern browser without needing a web server, or upload it to any static hosting provider.

### Type Checking & UI Verification

Run Svelte and TypeScript checks:

```bash
npm run check
```

Run the automated end-to-end UI verification suite (requires [Microsoft Edge](https://www.microsoft.com/edge), launched via Playwright):

```bash
node scripts/verify-ui.mjs
```

---

## Connecting an LLM Server

PairQuill communicates with any server exposing an OpenAI-compatible `/v1/chat/completions` endpoint. Enter the API root — a trailing `/v1` is appended automatically when it's missing, so both `http://127.0.0.1:8888` and `http://127.0.0.1:8888/v1` work.

To configure a server, click the **gear icon** in the status bar (bottom right) or select a profile.

Click **Test connection** to verify connectivity and automatically populate the model dropdown.

---

## Content Rating

The top bar includes a three-stop **content rating** slider that controls how the model is guided on generated prose:

| Stop | Label | Guidance |
| :--- | :--- | :--- |
| 0 | SFW | Safe-for-work content only; romantic feelings may be implied, but physical intimacy stops at a kiss. |
| 1 | Romance / Softcore | Romantic and sensual content at a softcore level; fade to black before anything explicit. |
| 2 | Explicit / Hardcore | Explicit content is permitted when the story calls for it, written with direct detail and high prose quality. |

The selected stop is injected into the **system prompt of every request** — continuations, retries, and selection operations alike:

* If a server profile's prompt template contains a `{rating}` placeholder, the full rating block (`Content rating: <label>` plus its guidance) is substituted in place.
* Templates without the placeholder get the rating block appended to the end of the system prompt, so no request can ever miss the selected guidance.

The choice is clamped to the three valid stops and persisted with your app settings (legacy saves without a stored value default to SFW).

---

## Architecture & Data Storage

* **UI Framework**: [Svelte 5](https://svelte.dev/) with runes (`$state`, `$derived`, `$effect`) for fine-grained reactivity.
* **Styling**: [Tailwind CSS v4](https://tailwindcss.com/) with [daisyUI 5](https://daisyui.com/) and FontAwesome icons.
* **Bundling**: [Vite](https://vite.dev/) with `vite-plugin-singlefile` to inline all JavaScript, CSS, and SVG assets into one portable HTML file.
* **Storage**: Native browser **IndexedDB** (`pairquill` database) stores:
  * `documents`: Stories with content, world notes, character cards, tone notes, and context overrides.
  * `profiles`: Saved LLM server endpoints, parameters, and prompt templates.
  * `settings`: Theme preferences, typography, line measure, reply length, content rating, active story, and active profile.
  * `generations`: History of prompt inputs, outputs, and token counts.
* **Portability**:
  * **Project Files** (`pairquill-project-YYYY-MM-DD.json`): Complete JSON backups containing all documents, world data, server profiles, and generation records.
  * **Plain Text**: Standard `.txt` import and export for external editing or manuscript submission.

---

## License

MIT

