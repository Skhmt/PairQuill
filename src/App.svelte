<script lang="ts">
import type {
  AppSettings,
  BudgetBreakdown,
  ContentRating,
  EditorCommand,
  GenStats,
  GenerationRecord,
  ModelInfo,
  OpKind,
  RefreshResult,
  ServerProfile,
  StoryDoc,
  ThemeName,
} from './lib/types'
import { THEMES, clampRating } from './lib/types'
import { idbDeleteMany, idbGetAll, idbPut, idbPutMany, requestPersistentStorage } from './lib/idb'
import { downloadFile, slugify, uid, wordCount } from './lib/format'
import { buildProjectFile, parseProjectFile, PROJECT_FORMAT } from './lib/project'
import type { ProjectFile } from './lib/project'
import { listModels, chatStream } from './lib/llm'
import {
  buildChapterContext,
  buildSummaryRequest,
  chapterSummarySection,
  characterText,
  effectiveMaxTokens,
  renderSystemPrompt,
  toMessages,
  worldText,
} from './lib/prompts'
import {
  activeChapter,
  activeChapterIndex,
  addChapter,
  chapterDisplayTitle,
  deleteChapter,
  enableChapters,
  exportStoryText,
  isChaptered,
  normalizeDoc,
  removeChapters,
  renameChapter,
  reorderChapter,
  storyText,
} from './lib/chapters'
import { computeBudget, estimateTokens } from './lib/tokens'
import TopBar from './components/TopBar.svelte'
import ChapterOutline from './components/ChapterOutline.svelte'
import EditorPane from './components/EditorPane.svelte'
import StatusBar from './components/StatusBar.svelte'
import ShortcutsModal from './components/ShortcutsModal.svelte'
import ServerModal from './components/ServerModal.svelte'
import StoriesModal from './components/StoriesModal.svelte'
import WorldModal from './components/WorldModal.svelte'
import ContextModal from './components/ContextModal.svelte'
import AboutModal from './components/AboutModal.svelte'

// ---------- persisted state (loaded from / saved to IndexedDB) ----------
let docs = $state<StoryDoc[]>([])
let profiles = $state<ServerProfile[]>([])
let generations = $state<GenerationRecord[]>([])
let loaded = $state(false)

let settings = $state<AppSettings>({
  theme: 'abyss',
  activeProfileId: null,
  activeDocId: null,
  fontSize: 'md',
  measure: 'normal',
  fontFamily: 'serif',
  replyLength: 1024,
  rating: 0,
  outlineOpen: true,
  outlineWidth: 256,
})

// ---------- session state ----------
let models = $state<ModelInfo[]>([])
let storiesOpen = $state(false)
let worldOpen = $state(false)
let contextOpen = $state(false)
let shortcutsOpen = $state(false)
let aboutOpen = $state(false)
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
/** Content rating from the top-bar slider, clamped so hand-edited settings stay valid. */
const rating = $derived(clampRating(settings.rating))

const docChaptered = $derived(activeDoc ? isChaptered(activeDoc) : false)
const currentChapter = $derived(activeDoc ? activeChapter(activeDoc) : null)
const currentChapterIdx = $derived(activeDoc ? activeChapterIndex(activeDoc) : -1)
const viewMode = $derived<'chapter' | 'story'>(docChaptered ? (activeDoc?.viewMode ?? 'chapter') : 'chapter')
const outlineOpen = $derived(settings.outlineOpen ?? true)
const outlineWidth = $derived(settings.outlineWidth ?? 256)
let scrollToChapter = $state<{ id: string; seq: number } | null>(null)
let scrollSeq = 0
let summaryAbort: AbortController | null = null

/**
 * Debounced/throttled story content used for word-count and context-budget estimates
 * so typing and 60ms streaming flushes don't re-scan the entire story on every frame.
 */
let measuredContent = $state('')
let measuredTotal = $state('')
let lastMeasuredKey: string | null = null
let wasGenerating = false

$effect(() => {
  const d = activeDoc
  const chapter = currentChapter
  const content = d ? (docChaptered && viewMode === 'chapter' ? (chapter?.content ?? '') : storyText(d)) : ''
  const total = d ? storyText(d) : ''
  const key = d ? `${d.id}:${viewMode}:${chapter?.id ?? 'none'}` : null
  const generating = genStats.active

  if (!d) {
    measuredContent = ''
    measuredTotal = ''
    lastMeasuredKey = null
    wasGenerating = false
    return
  }

  // Update immediately when switching docs/chapters, finishing a generation, or opening ContextModal.
  if (key !== lastMeasuredKey || (wasGenerating && !generating) || contextOpen) {
    lastMeasuredKey = key
    wasGenerating = generating
    measuredContent = content
    measuredTotal = total
    return
  }

  wasGenerating = generating
  const delay = generating ? 500 : 250
  const t = setTimeout(() => {
    measuredContent = content
    measuredTotal = total
  }, delay)
  return () => clearTimeout(t)
})

const activeWordCount = $derived(activeDoc ? wordCount(measuredTotal) : 0)
const activeChapterWordCount = $derived(
  activeDoc && docChaptered && viewMode === 'chapter' ? wordCount(measuredContent) : null,
)

/** Approximate token budget for the active doc, shown in the Context tab. */
const budget = $derived.by((): BudgetBreakdown | null => {
  const d = activeDoc
  const p = activeProfile
  if (!d || !p) return null
  const chapterCtx = buildChapterContext(d)
  const summaryText = chapterCtx ? chapterSummarySection(chapterCtx) : ''
  const b = computeBudget({
    maxContext,
    systemPrompt: renderSystemPrompt(p, d, rating),
    worldText: worldText(d),
    characterText: characterText(d),
    toneText: d.tone,
    summaryText,
    storyContent: measuredContent,
    reserveTokens: replyCap,
  })
  return {
    systemTokens: b.systemTokens,
    worldTokens: b.worldTokens,
    characterTokens: b.characterTokens,
    summaryTokens: b.summaryTokens,
    storyTokens: b.storyTokens,
    reserveTokens: b.reserveTokens,
    storyTrimmed: b.fitsStoryChars < measuredContent.length,
  }
})

// ---------- persistence ----------
const SETTINGS_KEY = 'app'
const MAX_GENERATIONS = 200
const tabId = uid()
const syncChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pairquill-sync') : null
let loadFailed = false

async function loadAll() {
  try {
    const [d, p, s, g] = await Promise.all([
      idbGetAll<StoryDoc>('documents'),
      idbGetAll<ServerProfile>('profiles'),
      idbGetAll<AppSettings>('settings'),
      idbGetAll<GenerationRecord>('generations'),
    ])
    docs = d.map(normalizeDoc).sort((a, b) => b.updatedAt - a.updatedAt)
    for (const doc of docs) savedDocVersions.set(doc.id, doc.updatedAt)
    profiles = p
    const saved = s[0]
    if (saved) {
      settings = { ...settings, ...saved }
      // Legacy saves may hold the old 'light'/'dark' toggle values — map them onto presets.
      const rawTheme = settings.theme as string
      if (!THEMES.includes(rawTheme as ThemeName)) settings.theme = rawTheme === 'light' ? 'caramellatte' : 'abyss'
    }
    const sortedGenerations = g.sort((a, b) => b.ts - a.ts)
    generations = sortedGenerations.slice(0, MAX_GENERATIONS)
    for (const rec of generations) persistedGenerationIds.add(rec.id)
    // Over-cap records are dropped from state but still sit in IndexedDB — queue them.
    if (sortedGenerations.length > generations.length) {
      pendingGenerationDeletes.push(...sortedGenerations.slice(generations.length).map((r) => r.id))
    }
    void requestPersistentStorage()
  } catch (e) {
    loadFailed = true
    showToast(`Could not load saved data: ${(e as Error).message}`, 'error')
  } finally {
    loaded = true
    if (activeProfile?.baseUrl) void refreshModels()
  }
}
void loadAll()

let saveTimer: ReturnType<typeof setTimeout> | null = null
let activeWrite: Promise<void> | null = null
const savedDocVersions = new Map<string, number>()
const dirtyDocIds = new Set<string>()
const deletedDocIds = new Set<string>()
let profilesDirty = false
let settingsDirty = false
let generationsDirty = false
// Generation records already written to IndexedDB this session, plus ids queued for
// deletion — lets flushes write only the delta instead of rewriting every record.
const persistedGenerationIds = new Set<string>()
let pendingGenerationDeletes: string[] = []
let skipInitialTrack = true

function hasDirtyState(): boolean {
  return dirtyDocIds.size > 0 || deletedDocIds.size > 0 || profilesDirty || settingsDirty || generationsDirty
}

/**
 * IndexedDB structured-clones every value it stores, and a live $state proxy is not
 * cloneable (it throws DataCloneError). Round-trip through JSON to persist plain snapshots.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Sync a keyed store with the in-memory list: write every current record first, then
 * delete anything still sitting in IndexedDB that is no longer in state — otherwise
 * deleted records would reappear on the next reload. Used for profiles; generations use
 * cheaper delta writes in flushWritesOnce (see persistedGenerationIds).
 */
async function syncStore(
  store: 'profiles',
  items: { id: string }[],
): Promise<void> {
  const plainItems = items.map((i) => plain(i))
  await idbPutMany(store, plainItems)
  const keep = new Set(items.map((i) => i.id))
  const existing = await idbGetAll<{ id: string }>(store)
  const toDelete = existing.filter((x) => !keep.has(x.id)).map((x) => x.id)
  if (toDelete.length > 0) {
    await idbDeleteMany(store, toDelete)
  }
}

async function flushWritesOnce(): Promise<void> {
  if (loadFailed) return
  const tasks: Promise<unknown>[] = []
  let wrote = false

  if (dirtyDocIds.size > 0) {
    const snapshots: { doc: StoryDoc; updatedAt: number }[] = []
    for (const id of dirtyDocIds) {
      const doc = docs.find((d) => d.id === id)
      if (!doc) {
        dirtyDocIds.delete(id)
        continue
      }
      const snapshot = plain(doc)
      // Chaptered docs keep their text in `chapters`; the joined `content` copy is
      // rebuilt by normalizeDoc on load, so don't persist the same story twice.
      if (isChaptered(doc)) snapshot.content = ''
      snapshots.push({ doc: snapshot, updatedAt: doc.updatedAt })
    }
    if (snapshots.length > 0) {
      tasks.push(
        idbPutMany('documents', snapshots.map((s) => s.doc)).then(() => {
          wrote = true
          for (const s of snapshots) {
            savedDocVersions.set(s.doc.id, s.updatedAt)
            const live = docs.find((d) => d.id === s.doc.id)
            if (!live || live.updatedAt === s.updatedAt) {
              dirtyDocIds.delete(s.doc.id)
            }
          }
        }),
      )
    }
  }

  if (deletedDocIds.size > 0) {
    const toDelete = Array.from(deletedDocIds)
    tasks.push(
      idbDeleteMany('documents', toDelete).then(() => {
        wrote = true
        for (const id of toDelete) {
          deletedDocIds.delete(id)
          savedDocVersions.delete(id)
        }
      }),
    )
  }

  if (profilesDirty) {
    const snapshot = profiles.map((p) => ({ ...p }))
    tasks.push(
      syncStore('profiles', snapshot).then(() => {
        wrote = true
        profilesDirty = false
      }),
    )
  }

  if (settingsDirty) {
    const snapshot = plain(settings)
    tasks.push(
      idbPut('settings', snapshot, SETTINGS_KEY).then(() => {
        wrote = true
        settingsDirty = false
      }),
    )
  }

  if (generationsDirty || pendingGenerationDeletes.length > 0) {
    // Delta write: only records not yet in IndexedDB are put, and trimmed/deleted ids
    // are removed — the old full rewrite re-cloned up to MAX_GENERATIONS records on
    // every generation event.
    const fresh = generations.slice(0, MAX_GENERATIONS).filter((g) => !persistedGenerationIds.has(g.id))
    const toDelete = pendingGenerationDeletes.filter((id) => !generations.some((g) => g.id === id))
    tasks.push(
      (async () => {
        if (fresh.length > 0) await idbPutMany('generations', fresh.map((g) => plain(g)))
        if (toDelete.length > 0) await idbDeleteMany('generations', toDelete)
      })().then(() => {
        wrote = true
        for (const g of fresh) persistedGenerationIds.add(g.id)
        const done = new Set(toDelete)
        pendingGenerationDeletes = pendingGenerationDeletes.filter((id) => !done.has(id))
        generationsDirty = false
      }),
    )
  }

  if (tasks.length > 0) {
    await Promise.all(tasks)
    if (wrote) syncChannel?.postMessage({ tabId })
  }
}

async function writeAll(): Promise<void> {
  if (activeWrite) {
    await activeWrite
    if (hasDirtyState()) return writeAll()
    return
  }
  activeWrite = (async () => {
    try {
      while (hasDirtyState() && !loadFailed) {
        await flushWritesOnce()
      }
    } finally {
      activeWrite = null
    }
  })()
  await activeWrite
}

function scheduleSave(): void {
  if (loadFailed) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    saveTimer = null
    try {
      await writeAll()
    } catch {
      showToast('Could not save to browser storage.', 'error')
    }
  }, 800)
}

function flushPendingSaves(): void {
  if (loadFailed) return
  if (!saveTimer && !hasDirtyState()) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  void writeAll().catch(() => {})
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

// Track edits to the active doc without walking chapter content. The old deep
// touch(activeDoc) re-read every field of every chapter on each keystroke, making
// typing O(document size). Typing and chapter ops bump d.updatedAt, which the list
// effect below already compares against saved versions to dirty-track and schedule
// saves; this effect only needs the fields that can change without an updatedAt bump
// (world/character edits, doc settings, chapter metadata and summaries).
$effect(() => {
  if (!loaded || !activeDoc) return
  const d = activeDoc
  void d.title
  void d.tone
  void d.contextOverride
  void d.viewMode
  void d.activeChapterId
  void d.includeChapterSummaries
  for (const n of d.worldNotes) {
    void n.id
    void n.title
    void n.content
  }
  for (const c of d.characters) {
    void c.id
    void c.name
    void c.description
  }
  if (d.chapters) {
    for (const ch of d.chapters) {
      void ch.id
      void ch.title
      void ch.summary
      void ch.summarySource
      void ch.summaryUpdatedAt
    }
  }
  if (skipInitialTrack) return
  dirtyDocIds.add(d.id)
  deletedDocIds.delete(d.id)
  scheduleSave()
})

// Track doc list additions, deletions, and shallow metadata edits (e.g. renaming inactive docs).
$effect(() => {
  if (!loaded) return
  const currentIds = new Set<string>()
  let changed = false
  for (const d of docs) {
    currentIds.add(d.id)
    void d.title
    if (savedDocVersions.get(d.id) !== d.updatedAt) {
      dirtyDocIds.add(d.id)
      deletedDocIds.delete(d.id)
      changed = true
    }
  }
  for (const id of savedDocVersions.keys()) {
    if (!currentIds.has(id)) {
      deletedDocIds.add(id)
      dirtyDocIds.delete(id)
      changed = true
    }
  }
  if (changed && !skipInitialTrack) scheduleSave()
})

$effect(() => {
  if (!loaded) return
  touch(profiles)
  if (skipInitialTrack) return
  profilesDirty = true
  scheduleSave()
})

$effect(() => {
  if (!loaded) return
  touch(settings)
  if (skipInitialTrack) return
  settingsDirty = true
  scheduleSave()
})

$effect(() => {
  if (!loaded) return
  void generations.length
  void generations[0]?.id
  if (skipInitialTrack) {
    skipInitialTrack = false
    return
  }
  generationsDirty = true
  scheduleSave()
})

// Flush pending writes when the tab is hidden or closed so a quick reload or mobile
// backgrounding doesn't lose recent edits.
window.addEventListener('pagehide', flushPendingSaves)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingSaves()
})

if (syncChannel) {
  syncChannel.onmessage = (e: MessageEvent<{ tabId?: string }>) => {
    if (e.data?.tabId && e.data.tabId !== tabId) {
      showToast('Another PairQuill tab saved changes. Reload this tab to avoid overwriting them.', 'error')
    }
  }
}

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
  downloadFile(`${slugify(doc.title)}.txt`, exportStoryText(doc), 'text/plain')
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
    const removedGenerations = generations.filter((g) => g.docId === doc.id)
    generations = generations.filter((g) => g.docId !== doc.id)
    for (const r of removedGenerations) {
      persistedGenerationIds.delete(r.id)
      pendingGenerationDeletes.push(r.id)
    }
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
async function refreshModels(): Promise<RefreshResult> {
  const p = activeProfile
  if (!p || !p.baseUrl) {
    showToast('Add a base URL to this profile first.', 'error')
    return { ok: false, message: 'No base URL set' }
  }
  try {
    models = await listModels(p.baseUrl, p.apiKey)
    // Remember the selection so it survives restarts. Prefer a model the server
    // reports as loaded (LM Studio etc.) over an unloaded one.
    if (models.length > 0) {
      const preferred = models.find((m) => m.loaded) ?? models[0]
      if (!p.modelId) p.modelId = preferred.id
      else if (!models.some((m) => m.id === p.modelId)) {
        // Selection no longer exists on this server (uninstalled/renamed/removed):
        // fall back to the preferred model instead of silently sending requests
        // to a dead id — and re-derive context from a real model.
        showToast(`Model "${p.modelId}" is no longer available on ${p.name}; switched to ${preferred.id}.`, 'info')
        p.modelId = preferred.id
      }
    }
    return { ok: true, count: models.length }
  } catch (e) {
    const msg = (e as Error).message || 'Connection failed'
    showToast(`Could not list models: ${msg}`, 'error')
    return { ok: false, message: msg }
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

// ---------- chapter actions ----------
function guardNotGenerating(): boolean {
  if (!genStats.active) return true
  showToast('Stop the current generation first.', 'error')
  return false
}

function handleSelectChapter(id: string) {
  if (!activeDoc || !docChaptered) return
  if (genStats.active && id !== currentChapter?.id) {
    showToast('Stop the current generation first.', 'error')
    return
  }
  activeDoc.activeChapterId = id
  if (viewMode === 'story') {
    scrollToChapter = { id, seq: ++scrollSeq }
  }
}

function handleStepChapter(dir: -1 | 1) {
  if (!activeDoc || !docChaptered || !activeDoc.chapters) return
  const nextIdx = currentChapterIdx + dir
  if (nextIdx < 0 || nextIdx >= activeDoc.chapters.length) return
  handleSelectChapter(activeDoc.chapters[nextIdx].id)
}

function handleSetViewMode(mode: 'chapter' | 'story') {
  if (!activeDoc || !docChaptered) return
  if (genStats.active && mode !== viewMode) {
    showToast('Stop the current generation first.', 'error')
    return
  }
  activeDoc.viewMode = mode
  activeDoc.updatedAt = Date.now()
}

function handleEnableChapters() {
  if (!activeDoc || docChaptered || !guardNotGenerating()) return
  enableChapters(activeDoc)
  settings.outlineOpen = true
}

function handleRemoveChapters() {
  if (!activeDoc || !docChaptered || !guardNotGenerating()) return
  const d = activeDoc
  askConfirm(
    'Disable chapters',
    'Merge all chapters back into a single story? Per-chapter summaries will be discarded.',
    () => {
      removeChapters(d)
    },
    'Disable',
  )
}

function handleAddChapter() {
  if (!activeDoc || !guardNotGenerating()) return
  addChapter(activeDoc)
}

function handleRenameChapter(id: string, title: string) {
  if (!activeDoc || !guardNotGenerating()) return
  renameChapter(activeDoc, id, title)
}

function handleReorderChapter(fromId: string, toId: string) {
  if (!activeDoc || !guardNotGenerating()) return
  reorderChapter(activeDoc, fromId, toId)
}

function handleDeleteChapter(id: string) {
  if (!activeDoc?.chapters || !guardNotGenerating()) return
  const ch = activeDoc.chapters.find((c) => c.id === id)
  if (!ch) return
  const idx = activeDoc.chapters.indexOf(ch)
  const title = chapterDisplayTitle(ch, idx)
  const words = wordCount(ch.content)
  const d = activeDoc
  askConfirm(
    'Delete chapter',
    `Delete chapter "${title}" and its ${words.toLocaleString()} words? This cannot be undone.`,
    () => {
      deleteChapter(d, id)
    },
    'Delete',
  )
}

function handleUpdateSummary(id: string, summary: string) {
  if (!activeDoc?.chapters) return
  const ch = activeDoc.chapters.find((c) => c.id === id)
  if (!ch) return
  const trimmed = summary.trim()
  if ((ch.summary ?? '') === trimmed) return
  ch.summary = trimmed || undefined
  ch.summaryUpdatedAt = trimmed ? Date.now() : undefined
  ch.summarySource = trimmed ? 'manual' : undefined
  ch.summaryStale = false
  activeDoc.updatedAt = Date.now()
}

function handleDismissStaleSummary(id: string) {
  if (!activeDoc?.chapters) return
  const ch = activeDoc.chapters.find((c) => c.id === id)
  if (!ch || !ch.summaryStale) return
  ch.summaryStale = false
  activeDoc.updatedAt = Date.now()
}

async function runSummarize(doc: StoryDoc, chapterId: string) {
  const ch = doc.chapters?.find((c) => c.id === chapterId)
  if (!ch || !activeProfile || !activeProfile.modelId) return
  const req = buildSummaryRequest(activeProfile, doc, ch, maxContext, rating)
  const estPrompt = estimateTokens(req.systemPrompt + '\n' + req.userMessage)
  const effParams = { ...activeProfile.params, maxTokens: 256 }
  const controller = new AbortController()
  summaryAbort = controller
  genStats = { active: true, promptTokens: estPrompt, completionTokens: 0, label: 'Summarizing' }
  let full = ''
  try {
    const result = await chatStream(
      activeProfile.baseUrl,
      activeProfile.apiKey,
      activeProfile.modelId,
      toMessages(req.systemPrompt, req.userMessage),
      effParams,
      controller.signal,
      {
        onToken: (t) => {
          full += t
        },
        onUsage: (u) => {
          genStats = {
            active: true,
            promptTokens: u.prompt_tokens ?? estPrompt,
            completionTokens: u.completion_tokens ?? estimateTokens(full),
            label: 'Summarizing',
          }
        },
      },
    )
    const trimmed = full.trim()
    if (!trimmed) {
      showToast('The model returned an empty summary.', 'error')
      return
    }
    ch.summary = trimmed
    ch.summaryUpdatedAt = Date.now()
    ch.summarySource = 'auto'
    ch.summaryStale = false
    doc.updatedAt = Date.now()
    const idx = doc.chapters?.indexOf(ch) ?? -1
    handleGeneration({
      id: uid(),
      ts: Date.now(),
      docId: doc.id,
      model: activeProfile.modelId,
      op: 'custom',
      instruction: 'Summarize chapter',
      params: effParams,
      systemPrompt: req.systemPrompt,
      output: trimmed,
      promptTokens: result.promptTokens ?? estPrompt,
      completionTokens: result.completionTokens ?? estimateTokens(trimmed),
      chapterId: ch.id,
      chapterTitle: idx >= 0 ? chapterDisplayTitle(ch, idx) : undefined,
    })
  } catch (e) {
    const err = e as Error
    if (err.name !== 'AbortError') {
      showToast(err.message || 'Summary generation failed', 'error')
    }
  } finally {
    summaryAbort = null
    genStats = { active: false, promptTokens: 0, completionTokens: 0 }
  }
}

function handleSummarizeChapter(id: string) {
  if (!activeDoc?.chapters || !guardNotGenerating()) return
  const ch = activeDoc.chapters.find((c) => c.id === id)
  if (!ch) return
  if (!activeProfile) {
    showToast('Set up a server profile first (gear icon → Servers).', 'error')
    return
  }
  if (!activeProfile.modelId) {
    showToast('Select a model for this profile first (gear icon → Servers).', 'error')
    return
  }
  const d = activeDoc
  if (ch.summary?.trim()) {
    askConfirm('Replace summary', 'Replace the current summary?', () => {
      void runSummarize(d, id)
    }, 'Replace')
  } else {
    void runSummarize(d, id)
  }
}

// ---------- generation callbacks ----------
function handleGeneration(g: GenerationRecord) {
  generations.unshift(g)
  if (generations.length > MAX_GENERATIONS) {
    const dropped = generations.slice(MAX_GENERATIONS)
    generations = generations.slice(0, MAX_GENERATIONS)
    for (const r of dropped) {
      persistedGenerationIds.delete(r.id)
      pendingGenerationDeletes.push(r.id)
    }
  }
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
    if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
      if (docChaptered) {
        e.preventDefault()
        settings.outlineOpen = !outlineOpen
      }
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
    onSetTheme={(t) => (settings.theme = t)}
    onOpenShortcuts={() => (shortcutsOpen = true)}
    onOpenAbout={() => (aboutOpen = true)}
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
    onOpenCustom={() => {
      commandRef = { kind: 'open-custom' }
    }}
    onOpenInstruct={() => {
      commandRef = { kind: 'open-instruct' }
    }}
    onStop={() => {
      summaryAbort?.abort()
      commandRef = { kind: 'stop' }
    }}
    replyLength={settings.replyLength}
    onSetReplyLength={(n) => (settings.replyLength = n)}
    rating={rating}
    onSetRating={(r: ContentRating) => (settings.rating = r)}
    isChaptered={docChaptered}
    outlineOpen={outlineOpen}
    viewMode={viewMode}
    chapterIndex={currentChapterIdx}
    chapterCount={activeDoc?.chapters?.length ?? 0}
    chapterTitle={currentChapter && currentChapterIdx >= 0 ? chapterDisplayTitle(currentChapter, currentChapterIdx) : ''}
    onToggleOutline={() => (settings.outlineOpen = !outlineOpen)}
    onSetViewMode={handleSetViewMode}
    onStepChapter={handleStepChapter}
    onEnableChapters={handleEnableChapters}
    onRemoveChapters={handleRemoveChapters}
  />

  <div class="flex min-h-0 flex-1">
    {#if !loaded}
      <div class="flex flex-1 items-center justify-center text-sm opacity-60">
        <i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading…
      </div>
    {:else if activeDoc}
      {#if docChaptered}
        <ChapterOutline
          doc={activeDoc}
          genActive={genStats.active}
          open={outlineOpen}
          width={outlineWidth}
          onToggleOpen={() => (settings.outlineOpen = !outlineOpen)}
          onResize={(w) => (settings.outlineWidth = w)}
          onSelectChapter={handleSelectChapter}
          onAddChapter={handleAddChapter}
          onRenameChapter={handleRenameChapter}
          onReorderChapter={handleReorderChapter}
          onDeleteChapter={handleDeleteChapter}
          onSummarizeChapter={handleSummarizeChapter}
          onUpdateSummary={handleUpdateSummary}
          onDismissStaleSummary={handleDismissStaleSummary}
        />
      {/if}
      <div class="flex min-h-0 min-w-0 flex-1">
        {#key activeDoc.id + ':' + (viewMode === 'story' ? 'all' : (currentChapter?.id ?? 'none'))}
          <EditorPane
            doc={activeDoc}
            chapterId={docChaptered && viewMode === 'chapter' ? (currentChapter?.id ?? null) : null}
            storyMode={docChaptered && viewMode === 'story'}
            scrollToChapter={scrollToChapter}
            profile={activeProfile}
            command={commandRef}
            maxContext={maxContext}
            maxReplyTokens={replyCap}
            rating={rating}
            fontSize={settings.fontSize}
            measure={settings.measure}
            fontFamily={settings.fontFamily}
            onRetryAvailable={(h) => (retryAvailable = h)}
            onCommandDone={() => (commandRef = null)}
            onGeneration={handleGeneration}
            onGenStats={(s) => (genStats = s)}
            onSelectionChange={(info) => (selection = info)}
            onFocusChapter={(id) => {
              if (activeDoc) activeDoc.activeChapterId = id
            }}
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
    words={activeWordCount}
    chapterWords={activeChapterWordCount}
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
  <AboutModal open={aboutOpen} onClose={() => (aboutOpen = false)} />
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
    onRefreshModels={() => refreshModels()}
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
  <WorldModal open={worldOpen} onClose={() => (worldOpen = false)} doc={activeDoc} onConfirm={askConfirm} />
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
    <!-- Long API errors (rate limits, quota…) wrap in a box instead of one line. -->
    <div
      role="status"
      class={`fixed bottom-10 left-1/2 z-[60] w-auto max-w-[min(92vw,40rem)] -translate-x-1/2 rounded-xl border px-4 py-3 text-left text-sm shadow-lg ${toast.kind === 'error' ? 'border-error/50 bg-error text-error-content' : 'border-base-300 bg-neutral text-neutral-content'}`}
    >
      <div class="flex items-start gap-2">
        {#if toast.kind === 'error'}<i class="fa-solid fa-circle-exclamation mt-0.5 shrink-0"></i>{/if}
        <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{toast.msg}</span>
        <button
          type="button"
          class="-mr-1 -mt-1 h-6 w-6 shrink-0 rounded p-0 opacity-70 hover:opacity-100"
          title="Dismiss"
          onclick={() => {
            toast = null
            if (toastTimer) {
              clearTimeout(toastTimer)
              toastTimer = null
            }
          }}
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>
  {/if}
</div>