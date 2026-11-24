// Core data types for PairQuill. Everything is persisted to IndexedDB (see idb.ts).

export interface WorldNote {
  id: string
  title: string
  content: string
}

export interface CharacterCard {
  id: string
  name: string
  description: string
}

export interface SamplingParams {
  temperature: number
  topP: number
  maxTokens: number
  stopSequences: string[]
}

/** A saved LLM endpoint (llama.cpp, LM Studio, KoboldCpp, Unsloth Desktop, cloud OpenAI-compatible...). */
export interface ServerProfile {
  id: string
  name: string
  /** OpenAI-compatible API root, e.g. http://127.0.0.1:8888 (a trailing /v1 is appended if missing) */
  baseUrl: string
  apiKey: string
  modelId: string
  systemPromptTemplate: string
  params: SamplingParams
}

export interface ModelInfo {
  id: string
  contextLength?: number
  loaded?: boolean
}

/** Outcome of a model-list refresh — lets callers show inline feedback (App toasts errors itself). */
export type RefreshResult = { ok: true; count: number } | { ok: false; message: string }

/** A story document with its per-document side-channel data. */
export interface StoryDoc {
  id: string
  title: string
  content: string
  createdAt: number
  updatedAt: number
  worldNotes: WorldNote[]
  characters: CharacterCard[]
  tone: string
  /** Manual override of the model's reported context length (tokens). null = auto. */
  contextOverride: number | null
}

export type OpKind = 'expand' | 'condense' | 'grammar' | 'custom' | 'continue' | 'instruct' | 'retry'

export interface GenerationRecord {
  id: string
  ts: number
  docId: string
  model: string
  op: OpKind
  instruction: string
  params: SamplingParams
  systemPrompt: string
  output: string
  promptTokens?: number
  completionTokens?: number
}

/** DaisyUI preset themes offered by the top-bar Theme picker (kept in sync with app.css). */
export const THEMES = ['abyss', 'dim', 'caramellatte', 'corporate', 'retro', 'silk', 'valentine'] as const
export type ThemeName = (typeof THEMES)[number]

export interface AppSettings {
  theme: ThemeName
  activeProfileId: string | null
  activeDocId: string | null
  fontSize: 'sm' | 'md' | 'lg'
  measure: 'narrow' | 'normal' | 'wide'
  /** Editor font family (persisted). */
  fontFamily: 'serif' | 'sans' | 'mono'
  /** Max length of a generated reply in tokens — top-bar slider (persisted). */
  replyLength: number
}

/** Commands the editor executes (insert text / run an op / open a dialog / stop). */
export type EditorCommand =
  | { kind: 'op'; op: OpKind; customInstruction?: string }
  | { kind: 'insert'; text: string }
  | { kind: 'stop' }
  | { kind: 'open-custom' }
  | { kind: 'open-instruct' }

export interface GenStats {
  active: boolean
  promptTokens: number
  completionTokens: number
  /** Label of the running op (e.g. "Expand selection"), shown in the top bar. */
  label?: string
}

/** Per-section token estimates shown in the Context tab (see tokens.ts computeBudget). */
export interface BudgetBreakdown {
  systemTokens: number
  worldTokens: number
  characterTokens: number
  storyTokens: number
  reserveTokens: number
  storyTrimmed: boolean
}
