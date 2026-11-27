// Portable project files. "Save project" writes one .json that carries everything
// needed to keep working on the workspace in another browser or machine: every story
// with its side-channel data (world notes, characters, tone, context override), the
// saved server profiles, and the recent generation history — not just the text.

import type {
  Chapter,
  CharacterCard,
  GenerationRecord,
  OpKind,
  SamplingParams,
  ServerProfile,
  StoryDoc,
  WorldNote,
} from './types'
import { uid } from './format'
import { normalizeDoc as normalizeChapteredDoc } from './chapters'

export const PROJECT_FORMAT = 'pairquill-project'
const LEGACY_PROJECT_FORMAT = 'pairui-project'
const PROJECT_VERSION = 2

/** The on-disk shape of a saved project file. */
export interface ProjectFile {
  format: typeof PROJECT_FORMAT
  version: number
  exportedAt: number
  docs: StoryDoc[]
  profiles: ServerProfile[]
  generations: GenerationRecord[]
  /** Which story/profile was active when the file was written; restored on import. */
  settings: { activeDocId: string | null; activeProfileId: string | null }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

function normalizeWorldNote(raw: unknown): WorldNote {
  const n = obj(raw)
  return { id: str(n.id) || uid(), title: str(n.title), content: str(n.content) }
}

function normalizeCharacter(raw: unknown): CharacterCard {
  const c = obj(raw)
  return { id: str(c.id) || uid(), name: str(c.name), description: str(c.description) }
}

function normalizeChapter(raw: unknown): Chapter | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = obj(raw)
  let content = ''
  if (typeof c.content === 'string') {
    content = c.content
  } else if (c.content !== undefined && c.content !== null) {
    console.warn('Chapter content was not a string; coercing to string.')
    content = String(c.content)
  }
  const ch: Chapter = {
    id: str(c.id) || uid(),
    title: str(c.title, 'Untitled chapter'),
    content,
  }
  if (typeof c.summary === 'string') ch.summary = c.summary
  if (typeof c.summaryUpdatedAt === 'number' && Number.isFinite(c.summaryUpdatedAt)) {
    ch.summaryUpdatedAt = c.summaryUpdatedAt
  }
  if (c.summarySource === 'auto' || c.summarySource === 'manual') {
    ch.summarySource = c.summarySource
  }
  if (typeof c.summaryStale === 'boolean') {
    ch.summaryStale = c.summaryStale
  }
  return ch
}

function normalizeDoc(raw: unknown): StoryDoc {
  const d = obj(raw)
  const doc: StoryDoc = {
    id: str(d.id) || uid(),
    title: str(d.title, 'Imported story'),
    content: str(d.content),
    createdAt: num(d.createdAt, Date.now()),
    updatedAt: num(d.updatedAt, Date.now()),
    worldNotes: Array.isArray(d.worldNotes) ? d.worldNotes.map(normalizeWorldNote) : [],
    characters: Array.isArray(d.characters) ? d.characters.map(normalizeCharacter) : [],
    tone: str(d.tone),
    contextOverride:
      typeof d.contextOverride === 'number' && Number.isFinite(d.contextOverride) ? d.contextOverride : null,
  }
  if (Array.isArray(d.chapters) && d.chapters.length > 0) {
    const parsed = d.chapters.map(normalizeChapter).filter((c): c is Chapter => c !== null)
    if (parsed.length > 0) {
      doc.chapters = parsed
      doc.activeChapterId = str(d.activeChapterId) || null
      doc.viewMode = d.viewMode === 'story' ? 'story' : 'chapter'
      doc.includeChapterSummaries = Boolean(d.includeChapterSummaries)
      normalizeChapteredDoc(doc)
    }
  }
  return doc
}

function normalizeParams(raw: unknown): SamplingParams {
  const p = obj(raw)
  return {
    temperature: num(p.temperature, 0.8),
    topP: num(p.topP, 1),
    maxTokens: num(p.maxTokens, 0),
    stopSequences: Array.isArray(p.stopSequences)
      ? p.stopSequences.filter((s): s is string => typeof s === 'string')
      : [],
  }
}

function normalizeProfile(raw: unknown): ServerProfile {
  const p = obj(raw)
  return {
    id: str(p.id) || uid(),
    name: str(p.name, 'Imported server'),
    baseUrl: str(p.baseUrl),
    apiKey: str(p.apiKey),
    modelId: str(p.modelId),
    systemPromptTemplate: str(p.systemPromptTemplate),
    params: normalizeParams(p.params),
  }
}

const OPS: OpKind[] = ['expand', 'condense', 'grammar', 'custom', 'continue', 'instruct', 'retry']

function normalizeGeneration(raw: unknown): GenerationRecord {
  const g = obj(raw)
  return {
    id: str(g.id) || uid(),
    ts: num(g.ts, Date.now()),
    docId: str(g.docId),
    model: str(g.model),
    op: OPS.includes(g.op as OpKind) ? (g.op as OpKind) : 'custom',
    instruction: str(g.instruction),
    params: normalizeParams(g.params),
    systemPrompt: str(g.systemPrompt),
    output: str(g.output),
    promptTokens: typeof g.promptTokens === 'number' ? g.promptTokens : undefined,
    completionTokens: typeof g.completionTokens === 'number' ? g.completionTokens : undefined,
    ...(typeof g.chapterId === 'string' ? { chapterId: g.chapterId } : {}),
    ...(typeof g.chapterTitle === 'string' ? { chapterTitle: g.chapterTitle } : {}),
  }
}

/** Parse and validate a saved project file. Throws an Error with a user-friendly message. */
export function parseProjectFile(text: string): ProjectFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('that file is not valid JSON')
  }
  const root = obj(data)
  if (root.format !== PROJECT_FORMAT && root.format !== LEGACY_PROJECT_FORMAT) {
    throw new Error('not a PairQuill project file (saved with "Save project")')
  }
  const version = num(root.version, 1)
  if (version !== 1 && version !== 2) {
    throw new Error(`unsupported project file version (${version})`)
  }
  if (!Array.isArray(root.docs)) throw new Error('project file is missing its story list')
  return {
    format: PROJECT_FORMAT,
    version,
    exportedAt: num(root.exportedAt, Date.now()),
    docs: root.docs.map(normalizeDoc),
    profiles: Array.isArray(root.profiles) ? root.profiles.map(normalizeProfile) : [],
    generations: Array.isArray(root.generations) ? root.generations.map(normalizeGeneration) : [],
    settings: {
      activeDocId: str(obj(root.settings).activeDocId) || null,
      activeProfileId: str(obj(root.settings).activeProfileId) || null,
    },
  }
}

/** Snapshot the current workspace into a plain, cloneable ProjectFile. */
export function buildProjectFile(
  docs: StoryDoc[],
  profiles: ServerProfile[],
  generations: GenerationRecord[],
  activeDocId: string | null,
  activeProfileId: string | null,
  includeApiKeys = false,
): ProjectFile {
  const sanitizedProfiles = profiles.map((p) => ({
    ...p,
    apiKey: includeApiKeys ? p.apiKey : '',
  }))
  // Chaptered docs keep their text in `chapters`; drop the redundant joined `content`
  // copy (normalizeDoc rebuilds it on import) so each story isn't stored twice.
  const exportDocs = docs.map((d) =>
    Array.isArray(d.chapters) && d.chapters.length > 0 ? { ...d, content: '' } : d,
  )
  return JSON.parse(
    JSON.stringify({
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      exportedAt: Date.now(),
      docs: exportDocs,
      profiles: sanitizedProfiles,
      generations,
      settings: { activeDocId, activeProfileId },
    }),
  ) as ProjectFile
}
