<script lang="ts">
import type {
  AppSettings,
  BudgetBreakdown,
  EditorCommand,
  GenStats,
  GenerationRecord,
  ModelInfo,
  OpKind,
  ServerProfile,
  StoryDoc,
} from './lib/types'
import { idbDelete, idbDeleteMany, idbGetAll, idbPut, idbPutMany } from './lib/idb'
import { downloadFile, slugify, uid, wordCount } from './lib/format'
import { buildProjectFile, parseProjectFile, PROJECT_FORMAT } from './lib/project'
import type { ProjectFile } from './lib/project'
import { listModels } from './lib/llm'
import { characterText, effectiveMaxTokens, renderSystemPrompt, worldText } from './lib/prompts'
import { computeBudget } from './lib/tokens'
import TopBar from './components/TopBar.svelte'
import EditorPane from './components/EditorPane.svelte'
import StatusBar from './components/StatusBar.svelte'
import ShortcutsModal from './components/ShortcutsModal.svelte'
import ServerModal from './components/ServerModal.svelte'
import StoriesModal from './components/StoriesModal.svelte'
import WorldModal from './components/WorldModal.svelte'
import ContextModal from './components/ContextModal.svelte'

// ---------- persisted state (loaded from / saved to IndexedDB) ----------
let docs = $state<StoryDoc[]>([])
let profiles = $state<ServerProfile[]>([])
let generations = $state<GenerationRecord[]>([])
let loaded = $state(false)

let settings = $state<AppSettings>({
  theme: 'dark',
  activeProfileId: null,
  activeDocId: null,
  fontSize: 'md',
  measure: 'normal',
  fontFamily: 'serif',
  replyLength: 1024,
})

// ---------- session state ----------
let models = $state<ModelInfo[]>([])
let storiesOpen = $state(false)
let worldOpen = $state(false)
let contextOpen = $state(false)
let shortcutsOpen = $state(false)
let serversOpen = $state(false)
let genStats = $state<GenStats>({ active: false, promptTokens: 0, completionTokens: 0 })
/** Live selection state from the editor (top bar hint + op button states). */
let selection = $state<{ has: boolean; words: number }>({ has: false, words: 0 })
/** True once the active doc has a generation Retry can re-send. */
let retryAvailable = $state(false)
let toast = $state<{ msg: string; kind: 'error' | 'info' } | null>(null)
/** One-shot command handed to EditorPane (insert text or run an op). */
let commandRef = $state<EditorCommand | null>(null)

const activeDoc = $derived(docs.find((d) => d.id === settings.activeDocId) ?? docs[0] ?? null)
const activeProfile = $derived(
  profiles.find((p) => p.id === settings.activeProfileId) ?? profiles[0] ?? null,
)
const activeModelInfo = $derived(models.find((m) => m.id === activeProfile?.modelId) ?? null)
/** Effective context window: per-doc override → model metadata → conservative default. */
const maxContext = $derived(activeDoc?.contextOverride ?? activeModelInfo?.contextLength ?? 8192)
/** Warn (but still honor the override) when it exceeds the model's reported context length. */
const contextExceedsModel = $derived(
  activeDoc?.contextOverride != null &&
  typeof activeModelInfo?.contextLength === 'number' &&
  activeDoc.contextOverride > activeModelInfo.contextLength,
)
const modelLabel = $derived(activeProfile?.modelId ?? '')
/** Effective reply cap: top-bar slider, further limited by the profile's max tokens (if set). */
const replyCap = $derived(effectiveMaxTokens(activeProfile, settings.replyLength))

/** Approximate token budget for the active doc, shown in the Context tab. */
const budget = $derived.by((): BudgetBreakdown | null => {
  const d = activeDoc
  const p = activeProfile
  if (!d || !p) return null
  const b = computeBudget({
    maxContext,
    systemPrompt: renderSystemPrompt(p, d),
    worldText: worldText(d),
    characterText: characterText(d),
    toneText: d.tone,
    storyContent: d.content,
    reserveTokens: replyCap,
  })
  return {
    systemTokens: b.systemTokens,
    worldTokens: b.worldTokens,
    characterTokens: b.characterTokens,
    storyTokens: b.storyTokens,
    reserveTokens: b.reserveTokens,
    storyTrimmed: b.fitsStoryChars < d.content.length,
  }
})

// ---------- persistence ----------
const SETTINGS_KEY = 'app'
const MAX_GENERATIONS = 200

async function loadAll() {
  try {
    const [d, p, s, g] = await Promise.all([
      idbGetAll<StoryDoc>('documents'),
      idbGetAll<ServerProfile>('profiles'),
      idbGetAll<AppSettings>('settings'),
      idbGetAll<GenerationRecord>('generations'),
    ])
    docs = d.sort((a, b) => b.updatedAt - a.updatedAt)
    profiles = p
    const saved = s[0]
    if (saved) settings = { ...settings, ...saved }
    generations = g.sort((a, b) => b.ts - a.ts).slice(0, MAX_GENERATIONS)
  } catch (e) {
    showToast(`Could not load saved data: ${(e as Error).message}`, 'error')
  } finally {
    loaded = true
    if (activeProfile?.baseUrl) void refreshModels()
  }
}
void loadAll()

let saveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * IndexedDB structured-clones every value it stores, and a live $state proxy is not
 * cloneable (it throws DataCloneError). Round-trip through JSON to persist plain snapshots.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Sync one keyed store with the in-memory list: write every current record and delete
 * anything still sitting in IndexedDB that is no longer in state — otherwise deleted
 * stories, profiles or generation records would reappear on the next reload.
 */
async function syncStore(
  store: 'documents' | 'profiles' | 'generations',
  items: { id: string }[],
): Promise<void> {
  const keep = new Set(items.map((i) => i.id))
  const existing = await idbGetAll<{ id: string }>(store)
  const toDelete = existing.filter((x) => !keep.has(x.id)).map((x) => x.id)
  await idbPutMany(store, items.map((i) => plain(i)))
  if (toDelete.length > 0) {
    await idbDeleteMany(store, toDelete)
  }
}

async function writeAll(): Promise<void> {
  await Promise.all([
    syncStore('documents', docs),
    syncStore('profiles', profiles),
    idbPut('settings', plain(settings), SETTINGS_KEY),
    syncStore('generations', generations.slice(0, MAX_GENERATIONS)),
  ])
}

/**
 * Recursively read every leaf of a state tree so the enclosing $effect subscribes to
 * each property. A bare read of a top-level $state variable only tracks reassignment —
 * in-place edits (profile.name = …, doc.content = …) live on nested sources and would
 * otherwise never schedule a save.
 */
function touch(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) touch(item)
    return
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) touch(record[key])
  }
}

$effect(() => {
  if (!loaded) return
  // read every persisted leaf so any nested mutation re-runs this effect
  touch(docs)
  touch(profiles)
  touch(settings)
  void generations.length // generations are append-only; length subscription avoids traversing prompt trees
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    try {
      await writeAll()
    } catch {
      showToast('Could not save to browser storage.', 'error')
    }
  }, 800)
})

// Flush a pending debounced write when the tab is hidden/closed so a quick reload
// right after an edit doesn't lose it (IndexedDB commits queued transactions on unload).
window.addEventListener('pagehide', () => {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  void writeAll().catch(() => {})
})

// ---------- toasts ----------
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(msg: string, kind: 'error' | 'info' = 'info') {
  toast = { msg, kind }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast = null), 4000)
}

// ---------- document actions ----------
function newDoc() {
  const now = Date.now()
  const d: StoryDoc = {
    id: uid(),
    title: 'Untitled story',
    content: '',
    createdAt: now,
    updatedAt: now,
    worldNotes: [],
    characters: [],
    tone: '',
    contextOverride: null,
  }
  docs.unshift(d)
  settings.activeDocId = d.id
}

async function importFile(file: File) {
  if (genStats.active) {
    showToast('Stop the current generation first.', 'error')
    return
  }
  if (file.size > 50 * 1024 * 1024) {
    showToast('File is too large (max 50MB).', 'error')
    return
  }
  let text: string
  try {
    text = await file.text()
  } catch (e) {
    showToast(`Import failed: ${(e as Error).message}`, 'error')
    return
  }
  // .json files (or anything that looks like one) are saved projects and restore the
  // whole workspace; everything else is plain text imported as a new story.
  if (/\.json$/i.test(file.name) || (text.trimStart().startsWith('{') && text.includes(PROJECT_FORMAT))) {
    importProjectText(text, file.name)
    return
  }
  const title = file.name.replace(/\.[^.]+$/, '') || 'Imported'
  const now = Date.now()
  const d: StoryDoc = {
    id: uid(),
    title,
    content: text,
    createdAt: now,
    updatedAt: now,
    worldNotes: [],
    characters: [],
    tone: '',
    contextOverride: null,
  }
  docs.unshift(d)
  settings.activeDocId = d.id
}

/**
 * Merge a saved project into the workspace without ever overwriting local data:
 * stories whose ids already exist get new ids (so both copies coexist), profiles and
 * generation records with existing ids are skipped, and references (generation docIds,
 * active story/profile) are remapped to the surviving ids.
 */
function importProjectText(text: string, sourceName: string) {
  let data: ProjectFile
  try {
    data = parseProjectFile(text)
  } catch (e) {
    showToast(`Import failed: ${(e as Error).message}`, 'error')
    return
  }
  const docIds = new Map<string, string>()
  for (const d of data.docs) {
    const id = docs.some((x) => x.id === d.id) ? uid() : d.id
    docIds.set(d.id, id)
    docs.unshift({ ...d, id })
  }
  const profileIds = new Map<string, string>()
  for (const p of data.profiles) {
    profileIds.set(p.id, p.id)
    if (!profiles.some((x) => x.id === p.id)) profiles.push({ ...p }) // keep the local copy on a clash
  }
  let newGens = 0
  for (const g of data.generations) {
    if (generations.some((x) => x.id === g.id)) continue
    generations.unshift({ ...g, docId: docIds.get(g.docId) ?? g.docId })
    newGens++
  }
  const activeDoc = data.settings.activeDocId ? docIds.get(data.settings.activeDocId) : null
  if (activeDoc && docs.some((x) => x.id === activeDoc)) settings.activeDocId = activeDoc
  const activeProfile = data.settings.activeProfileId ? profileIds.get(data.settings.activeProfileId) : null
  if (activeProfile && profiles.some((x) => x.id === activeProfile)) {
    settings.activeProfileId = activeProfile
    models = []
    void refreshModels()
  }
  const n = data.docs.length
  showToast(
    `Imported ${n} ${n === 1 ? 'story' : 'stories'}${newGens ? `, ${newGens} generation records` : ''} from ${sourceName}.`,
  )
}

function exportDoc(doc: StoryDoc) {
  downloadFile(`${slugify(doc.title)}.txt`, doc.content, 'text/plain')
}

/** Save the whole workspace (stories + world data, server profiles, history) to a portable .json. */
function exportProject() {
  const data = buildProjectFile(
    docs,
    profiles,
    generations.slice(0, MAX_GENERATIONS),
    settings.activeDocId,
    settings.activeProfileId,
  )
  const name = `pairquill-project-${new Date().toISOString().slice(0, 10)}.json`
  downloadFile(name, JSON.stringify(data, null, 2), 'application/json')
  showToast(`Saved ${docs.length} ${docs.length === 1 ? 'story' : 'stories'} to ${name}.`)
}

/** Save the current story (content + world data) as a single-story .json project file. */
function saveCurrentStory() {
  const d = activeDoc
  if (!d) return
  const data = buildProjectFile([d], [], [], d.id, null)
  const name = `${slugify(d.title)}-${new Date().toISOString().slice(0, 10)}.json`
  downloadFile(name, JSON.stringify(data, null, 2), 'application/json')
}

// Styled in-app confirmation — the native window.confirm ignores the theme entirely.
let confirmState = $state<{ title: string; message: string; action: () => void; label: string } | null>(null)
let confirmDlg: HTMLDialogElement | null = null

function askConfirm(title: string, message: string, action: () => void, label = 'Confirm'): void {
  confirmState = { title, message, action, label }
  confirmDlg?.showModal()
}

function deleteDoc(doc: StoryDoc) {
  if (genStats.active) {
    showToast('Stop the current generation first.', 'error')
    return
  }
  askConfirm('Delete story', `Delete "${doc.title}"? This cannot be undone.`, () => {
    docs = docs.filter((d) => d.id !== doc.id)
    generations = generations.filter((g) => g.docId !== doc.id)
    if (settings.activeDocId === doc.id) settings.activeDocId = docs[0]?.id ?? null
  }, 'Delete')
}

/** Select a story; returns false when blocked (an active generation). */
function selectDoc(id: string): boolean {
  // Switching mid-generation would redirect streamed text into the wrong doc.
  if (genStats.active && id !== activeDoc?.id) {
    showToast('Stop the current generation first.', 'error')
    return false
  }
  settings.activeDocId = id
  return true
}

// ---------- server profile / model actions ----------
async function refreshModels() {
  const p = activeProfile
  if (!p || !p.baseUrl) {
    showToast('Add a base URL to this profile first (gear icon).', 'error')
    return
  }
  try {
    models = await listModels(p.baseUrl, p.apiKey)
    if (!p.modelId && models.length > 0) {
      const preferred = models.find((m) => m.loaded) ?? models[0]
      p.modelId = preferred.id
    }
  } catch (e) {
    showToast(`Could not list models: ${(e as Error).message}`, 'error')
  }
}

function selectProfile(id: string) {
  settings.activeProfileId = id
  models = []
  void refreshModels()
}

function selectModel(id: string) {
  if (activeProfile) activeProfile.modelId = id
}

function addProfile() {
  const p: ServerProfile = {
    id: uid(),
    name: `Server ${profiles.length + 1}`,
    baseUrl: '',
    apiKey: '',
    modelId: '',
    systemPromptTemplate: '',
    params: { temperature: 0.8, topP: 1, maxTokens: 0, stopSequences: [] },
  }
  profiles.push(p)
  settings.activeProfileId = p.id
  models = []
}

function deleteProfile(p: ServerProfile) {
  askConfirm('Delete profile', `Delete profile "${p.name}"?`, () => {
    profiles = profiles.filter((x) => x.id !== p.id)
    if (settings.activeProfileId === p.id) {
      settings.activeProfileId = profiles[0]?.id ?? null
      models = []
    }
  }, 'Delete')
}

function openServers() {
  if (profiles.length === 0) addProfile()
  serversOpen = true
}

// ---------- generation callbacks ----------
function handleGeneration(g: GenerationRecord) {
  generations.unshift(g)
  if (generations.length > MAX_GENERATIONS) generations = generations.slice(0, MAX_GENERATIONS)
}

// ---------- commands & keyboard shortcuts ----------
function continueFromCursor() {
  if (!activeDoc || genStats.active) return
  commandRef = { kind: 'op', op: 'continue' }
}

function retryLast() {
  if (!activeDoc || genStats.active) return
  commandRef = { kind: 'op', op: 'retry' }
}

const OP_KEYS: Record<string, OpKind> = {
  e: 'expand',
  c: 'condense',
  g: 'grammar',
}

$effect(() => {
  function onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'F1') {
      e.preventDefault()
      shortcutsOpen = !shortcutsOpen
      return
    }
    if (mod && !e.shiftKey && e.key === 'Enter') {
      e.preventDefault()
      continueFromCursor()
      return
    }
    // Retry lives on Ctrl+Shift+Y: plain Ctrl+R (and Ctrl+Shift+R) are reserved
    // by the browser for reload, so we no longer intercept them.
    if (mod && e.shiftKey && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      retryLast()
      return
    }
    if (mod && e.shiftKey) {
      const op = OP_KEYS[e.key.toLowerCase()]
      if (!op) return
      if (!selection.has) {
        showToast('Select a passage in the editor first.', 'error')
        return
      }
      e.preventDefault()
      commandRef = { kind: 'op', op }
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
})
</script>

<div
  class="flex h-dvh w-full flex-col overflow-hidden bg-base-100 text-base-content"
  data-theme={settings.theme}
>
  <TopBar
    theme={settings.theme}
    hasDoc={!!activeDoc}
    selection={selection}
    retryAvailable={retryAvailable}
    genStats={genStats}
    fontSize={settings.fontSize}
    measure={settings.measure}
    fontFamily={settings.fontFamily}
    onToggleTheme={() => (settings.theme = settings.theme === 'dark' ? 'light' : 'dark')}
    onOpenShortcuts={() => (shortcutsOpen = true)}
    onImportFile={(f) => void importFile(f)}
    onSaveAll={exportProject}
    onSaveCurrent={saveCurrentStory}
    onExportTxt={() => activeDoc && exportDoc(activeDoc)}
    onOpenStories={() => (storiesOpen = true)}
    onOpenWorld={() => (worldOpen = true)}
    onSetFontSize={(s) => (settings.fontSize = s)}
    onSetMeasure={(m) => (settings.measure = m)}
    onSetFont={(f) => (settings.fontFamily = f)}
    onRunOp={(op) => {
      if (!activeDoc || genStats.active) return
      commandRef = { kind: 'op', op }
    }}
    onOpenCustom={() => (commandRef = { kind: 'open-custom' })}
    onOpenInstruct={() => (commandRef = { kind: 'open-instruct' })}
    onStop={() => (commandRef = { kind: 'stop' })}
    replyLength={settings.replyLength}
    onSetReplyLength={(n) => (settings.replyLength = n)}
  />

  <div class="flex min-h-0 flex-1">
    {#if !loaded}
      <div class="flex flex-1 items-center justify-center text-sm opacity-60">
        <i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading…
      </div>
    {:else if activeDoc}
      <div class="flex min-h-0 min-w-0 flex-1">
        {#key activeDoc.id}
          <EditorPane
            doc={activeDoc}
            profile={activeProfile}
            command={commandRef}
            maxContext={maxContext}
            maxReplyTokens={replyCap}
            fontSize={settings.fontSize}
            measure={settings.measure}
            fontFamily={settings.fontFamily}
            onRetryAvailable={(h) => (retryAvailable = h)}
            onCommandDone={() => (commandRef = null)}
            onGeneration={handleGeneration}
            onGenStats={(s) => (genStats = s)}
            onSelectionChange={(info) => (selection = info)}
            onError={(m) => showToast(m, 'error')}
          />
        {/key}
      </div>
    {:else}
      <div class="flex flex-1 flex-col items-center justify-center gap-3 opacity-70">
        <i class="fa-solid fa-feather-pointed text-4xl text-primary"></i>
        <p class="text-sm">No story selected.</p>
        <div class="flex gap-2">
          <button class="btn btn-primary" onclick={newDoc}>
            <i class="fa-solid fa-plus mr-1"></i>New story
          </button>
          <button class="btn" onclick={() => (storiesOpen = true)}>
            <i class="fa-solid fa-folder-open mr-1"></i>Stories
          </button>
        </div>
      </div>
    {/if}

  </div>

  <StatusBar
    words={activeDoc ? wordCount(activeDoc.content) : 0}
    budget={budget}
    maxContext={maxContext}
    exceedsModel={contextExceedsModel}
    genStats={genStats}
    profiles={profiles}
    activeProfile={activeProfile}
    models={models}
    onSelectProfile={selectProfile}
    onSelectModel={selectModel}
    onRefreshModels={() => void refreshModels()}
    onOpenServers={openServers}
    onShowContext={() => (contextOpen = true)}
  />

  <ShortcutsModal open={shortcutsOpen} onClose={() => (shortcutsOpen = false)} />
  <ServerModal
    open={serversOpen}
    onClose={() => (serversOpen = false)}
    profiles={profiles}
    activeProfileId={activeProfile?.id ?? null}
    models={models}
    onSelect={(id) => {
      settings.activeProfileId = id
      void refreshModels()
    }}
    onAdd={addProfile}
    onDelete={deleteProfile}
    onRefreshModels={() => void refreshModels()}
  />

  <StoriesModal
    open={storiesOpen}
    onClose={() => (storiesOpen = false)}
    docs={docs}
    activeId={activeDoc?.id ?? null}
    onSelect={(id) => {
      if (selectDoc(id)) storiesOpen = false
    }}
    onNew={() => {
      newDoc()
      storiesOpen = false
    }}
    onImportFile={(f) => void importFile(f)}
    onExport={exportDoc}
    onDelete={(id) => {
      const d = docs.find((x) => x.id === id)
      if (d) deleteDoc(d)
    }}
  />
  <WorldModal open={worldOpen} onClose={() => (worldOpen = false)} doc={activeDoc} />
  <ContextModal
    open={contextOpen}
    onClose={() => (contextOpen = false)}
    doc={activeDoc}
    budget={budget}
    maxContext={maxContext}
    modelLabel={modelLabel}
    exceedsModel={contextExceedsModel}
    modelContext={activeModelInfo?.contextLength}
  />

  <!-- Styled confirmation dialog — replaces the unthemed native window.confirm.
       Rendered last so it stacks above any other open modal (e.g. deleting a
       profile from within ServerModal). -->
  <dialog bind:this={confirmDlg} class="modal" aria-label="Confirm" onclose={() => (confirmState = null)}>
    <form method="dialog" class="modal-box max-w-sm">
      <h3 class="text-lg font-semibold">{confirmState?.title}</h3>
      <p class="py-2 text-sm opacity-70">{confirmState?.message}</p>
      <div class="modal-action justify-end">
        <button type="button" class="btn btn-ghost" onclick={() => confirmDlg?.close()}>Cancel</button>
        <button
          type="button"
          class="btn btn-error"
          onclick={() => {
            const a = confirmState?.action
            confirmDlg?.close()
            a?.()
          }}
        >
          {confirmState?.label ?? 'Confirm'}
        </button>
      </div>
    </form>
    <form method="dialog" class="modal-backdrop"><button>close</button></form>
  </dialog>

  {#if toast}
    <div
      role="status"
      class={`fixed bottom-10 left-1/2 z-[60] -translate-x-1/2 whitespace-nowrap rounded-xl px-4 py-2 text-sm shadow-lg ${toast.kind === 'error' ? 'bg-error text-error-content' : 'bg-neutral text-neutral-content'}`}
    >
      {#if toast.kind === 'error'}<i class="fa-solid fa-circle-exclamation mr-1"></i>{/if}
      {toast.msg}
    </div>
  {/if}
</div>