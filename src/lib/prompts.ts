// Prompt construction: system templates with world-data variables, and per-operation user messages.

import type { ChatMessage, } from './llm'
import type { OpKind, ServerProfile, StoryDoc } from './types'
import { computeBudget, storyTail } from './tokens'

export const OP_LABELS: Record<OpKind, string> = {
  expand: 'Expand',
  condense: 'Condense',
  grammar: 'Grammar',
  custom: 'Custom',
  continue: 'Continue',
  instruct: 'Instruct',
  retry: 'Retry',
}

const DEFAULT_SYSTEM_TEMPLATE = `You are a skilled co-writer collaborating on a story with the author. Follow the author's instructions precisely and match the established voice, tense, and style. Return only the requested text — no commentary, no preamble, no markdown fences.

World notes:
{world_notes}

Characters:
{characters}

Tone and style notes:
{tone}`

function sectionOrNone(s: string): string {
  return s.trim() ? s.trim() : '(none)'
}

export function worldText(doc: StoryDoc): string {
  return doc.worldNotes.map((n) => `## ${n.title}\n${n.content}`).join('\n\n')
}

export function characterText(doc: StoryDoc): string {
  return doc.characters.map((c) => `### ${c.name || 'Unnamed'}\n${c.description}`).join('\n\n')
}

/** Render the profile's system prompt template with the document's side-channel data. */
export function renderSystemPrompt(profile: ServerProfile, doc: StoryDoc): string {
  const tpl = profile.systemPromptTemplate.trim() || DEFAULT_SYSTEM_TEMPLATE
  return tpl
    .replaceAll('{world_notes}', sectionOrNone(worldText(doc)))
    .replaceAll('{characters}', sectionOrNone(characterText(doc)))
    .replaceAll('{tone}', sectionOrNone(doc.tone))
}

const OP_INSTRUCTIONS: Record<'expand' | 'condense' | 'grammar', string> = {
  expand:
    'Expand the selected passage with richer detail, sensory description, and depth. Keep the same events, POV, and voice.',
  condense:
    'Condense the selected passage into tighter prose. Cut redundancy while preserving the core content and tone.',
  grammar:
    'Fix grammar, spelling, and punctuation in the selected passage. Do not change wording, style, or content beyond corrections.',
}

const CONTEXT_CHARS = 1500

export interface BuiltRequest {
  systemPrompt: string
  userMessage: string
}

/**
 * The effective cap for how long one generated reply may be: the user's reply-length
 * setting, further limited by the profile's own max tokens (when set) so a server-side
 * limit can never be exceeded.
 */
export function effectiveMaxTokens(profile: ServerProfile | null, replyLength: number): number {
  const slider = Math.max(1, Math.round(replyLength))
  return profile && profile.params.maxTokens > 0 ? Math.min(slider, profile.params.maxTokens) : slider
}

/** Above this cap the limit rarely matters in practice, so no hint is added. */
const LENGTH_HINT_MAX_TOKENS = 2048

/**
 * Soft length guidance for the prompt body. max_tokens is a hard stop that can cut a
 * reply off mid-sentence, so when the effective cap is small enough to actually bite we
 * tell the model to aim for roughly that length and end on a natural break instead.
 */
function lengthHint(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0 || tokens > LENGTH_HINT_MAX_TOKENS) return ''
  // ~1.33 tokens per word of English prose; floor to a clean multiple of 25 so the
  // hinted word count stays safely under the hard cap.
  const words = Math.max(25, Math.floor((tokens * 0.75) / 25) * 25)
  return ` Keep your reply to about ${words} words or fewer, and end at a natural sentence or paragraph break.`
}

/** Build messages for a selection-targeted operation (expand/condense/grammar/custom). */
export function buildOpRequest(
  profile: ServerProfile,
  doc: StoryDoc,
  op: 'expand' | 'condense' | 'grammar' | 'custom',
  selection: string,
  selStart: number,
  customInstruction?: string,
): BuiltRequest {
  const systemPrompt = renderSystemPrompt(profile, doc)
  const before = doc.content.slice(Math.max(0, selStart - CONTEXT_CHARS), selStart)
  const instruction =
    op === 'custom'
      ? customInstruction?.trim() || 'Apply the requested change to the selected passage. Keep events and meaning intact.'
      : OP_INSTRUCTIONS[op]

  const userMessage = `You are editing a story. Use the context only to stay consistent with it — do not continue or retell it.

Context (story before the selection):
"""
${before.trim() || '(the selection is at the very start of the story)'}
"""

Selected passage:
"""
${selection}
"""

Task: ${instruction}

Return ONLY the revised passage as plain text. No commentary, no preamble, no markdown fences.`

  return { systemPrompt, userMessage }
}

/** Build "continue from cursor" messages, optionally guided by extra instructions. */
function buildCursorRequest(
  profile: ServerProfile,
  doc: StoryDoc,
  cursorPos: number,
  maxContext: number,
  instruction?: string,
  /** Effective reply cap (tokens): reserves context-window room and drives the soft length hint. */
  maxTokens?: number,
): BuiltRequest {
  const systemPrompt = renderSystemPrompt(profile, doc)
  // The hard cap that will actually be sent as max_tokens (slider ∩ profile limit).
  // When neither is set the server decides, so no length hint is added.
  const cap =
    maxTokens && maxTokens > 0 ? maxTokens : profile.params.maxTokens > 0 ? profile.params.maxTokens : 0
  // Reserve room for the reply we are about to generate so the story tail can never
  // push the request past the model's context window.
  const budget = computeBudget({
    maxContext,
    systemPrompt,
    worldText: worldText(doc),
    characterText: characterText(doc),
    toneText: doc.tone,
    storyContent: doc.content.slice(0, cursorPos),
    reserveTokens: cap > 0 ? cap : 500,
  })
  const tail = storyTail(doc.content.slice(0, cursorPos), budget.fitsStoryChars)
  const guidance = instruction?.trim()
    ? ` Follow this instruction as you continue: ${instruction.trim()}`
    : ''

  const userMessage = `The story so far:
"""
${tail.trim() || '(this is the very beginning of the story — start it now)'}
"""

Continue the story from exactly where it left off.${guidance} Write only new text that follows naturally — do not repeat or summarize anything already written. Match the established voice and tense.${lengthHint(cap)} Return ONLY the continuation as plain text.`

  return { systemPrompt, userMessage }
}

/** Build messages for "continue from cursor", respecting the context budget. */
export function buildContinueRequest(
  profile: ServerProfile,
  doc: StoryDoc,
  cursorPos: number,
  maxContext: number,
  maxTokens?: number,
): BuiltRequest {
  return buildCursorRequest(profile, doc, cursorPos, maxContext, undefined, maxTokens)
}

/** Build messages for "instruct": continue from the cursor with custom guidance. */
export function buildInstructRequest(
  profile: ServerProfile,
  doc: StoryDoc,
  cursorPos: number,
  maxContext: number,
  instruction: string,
  maxTokens?: number,
): BuiltRequest {
  return buildCursorRequest(profile, doc, cursorPos, maxContext, instruction, maxTokens)
}

export function toMessages(systemPrompt: string, userMessage: string): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ]
}
