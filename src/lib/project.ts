// Portable project files. "Save project" writes one .json that carries everything
// needed to keep working on the workspace in another browser or machine: every story
// with its side-channel data (world notes, characters, tone, context override), the
// saved server profiles, and the recent generation history — not just the text.

import type {
  CharacterCard,
  GenerationRecord,
  OpKind,
  SamplingParams,
  ServerProfile,
  StoryDoc,
  WorldNote,
} from './types'
import { uid } from './format'

export const PROJECT_FORMAT = 'pairquill-project'
export const LEGACY_PROJECT_FORMAT = 'pairui-project'
export const PROJECT_VERSION = 1

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

function normalizeDoc(raw: unknown): StoryDoc {
  const d = obj(raw)
  return {
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
  if (!Array.isArray(root.docs)) throw new Error('project file is missing its story list')
  return {
    format: PROJECT_FORMAT,
    version: num(root.version, 1),
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
  return JSON.parse(
    JSON.stringify({
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      exportedAt: Date.now(),
      docs,
      profiles: sanitizedProfiles,
      generations,
      settings: { activeDocId, activeProfileId },
    }),
  ) as ProjectFile
}
