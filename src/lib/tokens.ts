// Local token estimation fallback (used when the service doesn't report counts)
// plus context budget computation for the visualization bar.

import { wordCount } from './format'

/** Rough heuristic: ~4 chars/token, floored by a word-based estimate (~1.3 tokens/word). */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const words = wordCount(text)
  return Math.max(Math.ceil(text.length / 4), Math.round(words * 1.3))
}

interface ContextBudget {
  max: number
  systemTokens: number
  worldTokens: number
  characterTokens: number
  storyTokens: number
  reserveTokens: number
  used: number
  /** How many characters of the story tail fit in the remaining window. */
  fitsStoryChars: number
}

export function computeBudget(opts: {
  maxContext: number
  systemPrompt: string
  worldText: string
  characterText: string
  toneText: string
  storyContent: string
  reserveTokens: number
}): ContextBudget {
  const max = Math.max(1, opts.maxContext)
  const systemTokens = estimateTokens(opts.systemPrompt)
  const worldTokens = estimateTokens(opts.worldText + '\n' + opts.toneText)
  const characterTokens = estimateTokens(opts.characterText)

  const available = Math.max(0, max - systemTokens - worldTokens - characterTokens - opts.reserveTokens)
  // ~4 chars per token for the tail slice; then re-estimate precisely from the end.
  let fitsStoryChars = Math.floor(available * 4)
  const full = opts.storyContent
  let storyTokens = 0
  if (full.length > fitsStoryChars) {
    const tail = full.slice(full.length - fitsStoryChars)
    storyTokens = estimateTokens(tail)
    // one correction pass: trim a bit more if we overshot
    if (storyTokens > available) {
      fitsStoryChars = Math.floor(fitsStoryChars * (available / Math.max(1, storyTokens)))
      storyTokens = estimateTokens(full.slice(full.length - fitsStoryChars))
    }
  } else {
    storyTokens = estimateTokens(full)
    fitsStoryChars = full.length
  }

  return {
    max,
    systemTokens,
    worldTokens,
    characterTokens,
    storyTokens,
    reserveTokens: opts.reserveTokens,
    used: systemTokens + worldTokens + characterTokens + storyTokens,
    fitsStoryChars,
  }
}

/** The tail of the story that fits in the budget (from the end). */
export function storyTail(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return content.slice(content.length - maxChars)
}
