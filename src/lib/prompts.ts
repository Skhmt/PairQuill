// Prompt construction: system templates with world-data variables, and per-operation user messages.

import type { ChatMessage } from './llm'
import type { Chapter, ContentRating, OpKind, ServerProfile, StoryDoc } from './types'
import { RATING_LEVELS } from './types'
import { computeBudget, storyTail } from './tokens'
import { activeChapter, chapterDisplayTitle, isChaptered } from './chapters'

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

/** Content-level guidance injected into every system prompt, keyed by the top-bar rating slider. */
const RATING_GUIDANCE: Record<ContentRating, string> = {
  0: 'Keep all generated content safe for work: nothing sexual, explicit, or graphic. Romantic feelings may be implied, but physical intimacy stops at a kiss — fade out before anything more.',
  1: 'Write romantic and sensual content at a softcore level: affection, kissing, emotional intimacy, and charged tension are welcome, but never depict sexual acts directly. Fade to black before anything explicit and keep descriptions tasteful rather than graphic.',
  2: 'Explicit content is permitted when the story calls for it: write intimate or sexual scenes with direct, unflinching detail and high prose quality, staying consistent with the characters, tone, and world above.',
}

/** The "Content rating" block that every request's system prompt must carry. */
export function ratingSection(rating: ContentRating): string {
  const level = RATING_LEVELS.find((r) => r.id === rating) ?? RATING_LEVELS[0]
  return `Content rating: ${level.label}\n${RATING_GUIDANCE[level.id]}`
}

export interface ChapterContext {
  /** e.g. "Ch. 3 · Title" for the label line. */
  currentTitle: string
  /** Non-current chapters that have a non-empty summary. */
  others: { number: number; title: string; summary: string }[]
}

/** Build ChapterContext for a doc when in Chapter mode with summaries enabled; else undefined. */
export function buildChapterContext(doc: StoryDoc): ChapterContext | undefined {
  if (!isChaptered(doc)) return undefined
  if ((doc.viewMode ?? 'chapter') !== 'chapter') return undefined
  if (!doc.includeChapterSummaries) return undefined
  const list = doc.chapters!
  const current = activeChapter(doc)
  if (!current) return undefined
  const currentIdx = list.indexOf(current)
  const currentTitle = `Ch. ${currentIdx + 1} · ${chapterDisplayTitle(current, currentIdx)}`
  const others: ChapterContext['others'] = []
  for (let i = 0; i < list.length; i++) {
    if (i === currentIdx) continue
    const summary = list[i].summary?.trim()
    if (!summary) continue
    others.push({
      number: i + 1,
      title: chapterDisplayTitle(list[i], i),
      summary,
    })
  }
  return { currentTitle, others }
}

/** Format the "other chapters (summarized)" system prompt block (§7.3). */
export function chapterSummarySection(ctx: ChapterContext): string {
  if (ctx.others.length === 0) return ''
  const lines = ctx.others.map((o) => `Ch. ${o.number} · ${o.title}: ${o.summary}`)
  return [
    'Story so far — other chapters (summarized):',
    ...lines,
    `You are currently writing inside "${ctx.currentTitle}". Use the summaries above for consistency, but do not retell or reference them unless the story naturally does.`,
  ].join('\n')
}

/**
 * Render the profile's system prompt template with the document's side-channel data.
 * The {rating} placeholder injects the content-rating block; templates without it get
 * the block appended, so every request always carries the selected rating's guidance.
 * When `chapterCtx` is provided and has summaries, the {chapters} placeholder (or append
 * fallback) injects the non-current chapter summaries block.
 */
export function renderSystemPrompt(
  profile: ServerProfile,
  doc: StoryDoc,
  rating: ContentRating,
  chapterCtx?: ChapterContext,
): string {
  const tpl = profile.systemPromptTemplate.trim() || DEFAULT_SYSTEM_TEMPLATE
  const summaryBlock = chapterCtx ? chapterSummarySection(chapterCtx) : ''
  let out = tpl
    .replaceAll('{world_notes}', sectionOrNone(worldText(doc)))
    .replaceAll('{characters}', sectionOrNone(characterText(doc)))
    .replaceAll('{tone}', sectionOrNone(doc.tone))
    .replaceAll('{rating}', ratingSection(rating))
    .replaceAll('{chapters}', summaryBlock || '(none)')
  if (!tpl.includes('{rating}')) out += `\n\n${ratingSection(rating)}`
  if (summaryBlock && !tpl.includes('{chapters}')) out += `\n\n${summaryBlock}`
  return out
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

/** Active text for prompt construction: current chapter content in Chapter mode, else `doc.content`. */
function targetText(doc: StoryDoc): string {
  if (isChaptered(doc) && (doc.viewMode ?? 'chapter') === 'chapter') {
    return activeChapter(doc)?.content ?? doc.content
  }
  return doc.content
}

/** Build messages for a selection-targeted operation (expand/condense/grammar/custom). */
export function buildOpRequest(
  profile: ServerProfile,
  doc: StoryDoc,
  op: 'expand' | 'condense' | 'grammar' | 'custom',
  selection: string,
  selStart: number,
  rating: ContentRating,
  customInstruction?: string,
  chapterCtx?: ChapterContext,
): BuiltRequest {
  const systemPrompt = renderSystemPrompt(profile, doc, rating, chapterCtx)
  const text = targetText(doc)
  const before = text.slice(Math.max(0, selStart - CONTEXT_CHARS), selStart)
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
  rating: ContentRating,
  instruction?: string,
  /** Effective reply cap (tokens): reserves context-window room and drives the soft length hint. */
  maxTokens?: number,
  chapterCtx?: ChapterContext,
): BuiltRequest {
  const baseSystemPrompt = renderSystemPrompt(profile, doc, rating)
  const summaryText = chapterCtx ? chapterSummarySection(chapterCtx) : ''
  const systemPrompt = chapterCtx ? renderSystemPrompt(profile, doc, rating, chapterCtx) : baseSystemPrompt
  // The hard cap that will actually be sent as max_tokens (slider ∩ profile limit).
  // When neither is set the server decides, so no length hint is added.
  const cap =
    maxTokens && maxTokens > 0 ? maxTokens : profile.params.maxTokens > 0 ? profile.params.maxTokens : 0
  const text = targetText(doc)
  const beforeCursor = text.slice(0, cursorPos)
  // Reserve room for the reply we are about to generate so the story tail can never
  // push the request past the model's context window.
  const budget = computeBudget({
    maxContext,
    systemPrompt: baseSystemPrompt,
    worldText: worldText(doc),
    characterText: characterText(doc),
    toneText: doc.tone,
    summaryText,
    storyContent: beforeCursor,
    reserveTokens: cap > 0 ? cap : 500,
  })
  const tail = storyTail(beforeCursor, budget.fitsStoryChars)
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
  rating: ContentRating,
  maxTokens?: number,
  chapterCtx?: ChapterContext,
): BuiltRequest {
  return buildCursorRequest(profile, doc, cursorPos, maxContext, rating, undefined, maxTokens, chapterCtx)
}

/** Build messages for "instruct": continue from the cursor with custom guidance. */
export function buildInstructRequest(
  profile: ServerProfile,
  doc: StoryDoc,
  cursorPos: number,
  maxContext: number,
  instruction: string,
  rating: ContentRating,
  maxTokens?: number,
  chapterCtx?: ChapterContext,
): BuiltRequest {
  return buildCursorRequest(profile, doc, cursorPos, maxContext, rating, instruction, maxTokens, chapterCtx)
}

/** Build messages for summarizing a single chapter (§7.2). */
export function buildSummaryRequest(
  profile: ServerProfile,
  doc: StoryDoc,
  chapter: Chapter,
  maxContext: number,
  rating: ContentRating,
): BuiltRequest {
  const baseSystem = renderSystemPrompt(profile, doc, rating)
  const systemPrompt = `${baseSystem}\n\nSummarize the following chapter in 3–5 sentences for an AI co-writer who will continue the story later. Cover: what happens, key character states/decisions, and any open threads or foreshadowing. Return only the summary.`
  const budget = computeBudget({
    maxContext,
    systemPrompt,
    worldText: worldText(doc),
    characterText: characterText(doc),
    toneText: doc.tone,
    storyContent: chapter.content,
    reserveTokens: 200,
  })
  const tail = storyTail(chapter.content, budget.fitsStoryChars)
  const userMessage = `Chapter text:\n"""\n${tail.trim() || '(empty chapter)'}\n"""`
  return { systemPrompt, userMessage }
}

export function toMessages(systemPrompt: string, userMessage: string): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ]
}
