// Pure chapter helpers — no Svelte imports, safe for unit checks and UI alike.

import { uid } from './format'
import type { Chapter, StoryDoc } from './types'

/** True when the document has at least one chapter (i.e. chapter mode is enabled). */
export function isChaptered(doc: StoryDoc): boolean {
  return Array.isArray(doc.chapters) && doc.chapters.length > 0
}

/** Display title for a chapter: user-supplied title, or "Chapter N" when empty. */
export function chapterDisplayTitle(chapter: Chapter, index: number): string {
  const t = chapter.title.trim()
  return t || `Chapter ${index + 1}`
}

/** Resolve the active chapter of a chaptered doc (falls back to the first chapter). */
export function activeChapter(doc: StoryDoc): Chapter | null {
  if (!isChaptered(doc)) return null
  const list = doc.chapters!
  if (doc.activeChapterId) {
    const found = list.find((c) => c.id === doc.activeChapterId)
    if (found) return found
  }
  return list[0]
}

/** Index of the active chapter in `doc.chapters`, or -1 if not chaptered. */
export function activeChapterIndex(doc: StoryDoc): number {
  if (!isChaptered(doc)) return -1
  const ch = activeChapter(doc)
  return ch ? doc.chapters!.indexOf(ch) : -1
}

/** Canonical full story text: `doc.content` for legacy docs, or chapters joined by `\n\n`. */
export function storyText(doc: StoryDoc): string {
  if (!isChaptered(doc)) return doc.content
  return doc.chapters!.map((c) => c.content).join('\n\n')
}

/** Exported `.txt` story text: includes chapter headers above each chapter when chaptered. */
export function exportStoryText(doc: StoryDoc): string {
  if (!isChaptered(doc)) return doc.content
  return doc.chapters!.map((c, i) => `${chapterDisplayTitle(c, i)}\n\n${c.content}`).join('\n\n')
}

export interface FullStoryRender {
  text: string
  /** Start/end character offsets of each chapter in `text`, in chapter order. */
  ranges: { chapterId: string; start: number; end: number }[]
}

/**
 * Display-only concatenation for Full-story mode: each chapter is headed by its
 * display label and separated by `\n\n---\n\n`. Never persisted.
 */
export function fullStoryDisplayText(doc: StoryDoc): FullStoryRender {
  if (!isChaptered(doc)) {
    return { text: doc.content, ranges: [] }
  }
  const sep = '\n\n---\n\n'
  const parts: string[] = []
  const ranges: { chapterId: string; start: number; end: number }[] = []
  let pos = 0
  const list = doc.chapters!
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    const header = `Ch. ${i + 1} · ${chapterDisplayTitle(c, i)}\n\n`
    const block = header + c.content
    if (i > 0) pos += sep.length
    const start = pos
    const end = pos + block.length
    ranges.push({ chapterId: c.id, start, end })
    parts.push(block)
    pos = end
  }
  return { text: parts.join(sep), ranges }
}

/**
 * Repair chapter invariants on load/import:
 * - Non-chaptered docs (`chapters` absent or null) are left untouched.
 * - Duplicate/missing chapter ids are regenerated.
 * - Missing/empty titles fall back to `'Untitled chapter'`.
 * - `activeChapterId` is ensured to point at a valid chapter (else the first).
 * - `viewMode` defaults to `'chapter'`.
 * - `doc.content` is synced to `storyText(doc)`.
 */
export function normalizeDoc(doc: StoryDoc): StoryDoc {
  if (!Array.isArray(doc.chapters) || doc.chapters.length === 0) {
    if (Array.isArray(doc.chapters) && doc.chapters.length === 0) {
      doc.chapters = null
      doc.activeChapterId = null
      doc.viewMode = undefined
    }
    return doc
  }
  const seen = new Set<string>()
  for (const c of doc.chapters) {
    if (!c.id || typeof c.id !== 'string' || seen.has(c.id)) {
      c.id = uid()
    }
    seen.add(c.id)
    if (typeof c.title !== 'string' || !c.title.trim()) {
      c.title = 'Untitled chapter'
    }
    if (typeof c.content !== 'string') {
      c.content = String(c.content ?? '')
    }
    if (c.summary !== undefined && typeof c.summary !== 'string') {
      c.summary = undefined
    }
    if (c.summaryUpdatedAt !== undefined && (typeof c.summaryUpdatedAt !== 'number' || !Number.isFinite(c.summaryUpdatedAt))) {
      c.summaryUpdatedAt = undefined
    }
  }
  if (!doc.activeChapterId || !seen.has(doc.activeChapterId)) {
    doc.activeChapterId = doc.chapters[0].id
  }
  if (doc.viewMode !== 'chapter' && doc.viewMode !== 'story') {
    doc.viewMode = 'chapter'
  }
  doc.content = storyText(doc)
  return doc
}

/** Split a string cleanly at `offset` (clamped to `[0, content.length]`). */
export function splitContentAtOffset(content: string, offset: number): [string, string] {
  const pos = Math.max(0, Math.min(content.length, Math.floor(offset)))
  return [content.slice(0, pos), content.slice(pos)]
}

/** Convert a non-chaptered document into a single-chapter document. */
export function enableChapters(doc: StoryDoc): StoryDoc {
  if (isChaptered(doc)) return doc
  const id = uid()
  doc.chapters = [
    {
      id,
      title: doc.title.trim() || 'Chapter 1',
      content: doc.content,
    },
  ]
  doc.activeChapterId = id
  doc.viewMode = 'chapter'
  doc.updatedAt = Date.now()
  return doc
}

/** Merge all chapters back into `doc.content` and clear chapter metadata. */
export function removeChapters(doc: StoryDoc): StoryDoc {
  doc.content = storyText(doc)
  doc.chapters = null
  doc.activeChapterId = null
  doc.viewMode = undefined
  doc.includeChapterSummaries = undefined
  doc.updatedAt = Date.now()
  return doc
}

/** Insert a new empty chapter after `afterId` (or after activeChapterId, or at end). */
export function addChapter(
  doc: StoryDoc,
  afterId?: string | null,
  title?: string,
): { doc: StoryDoc; chapter: Chapter } {
  if (!isChaptered(doc)) {
    enableChapters(doc)
  }
  const list = doc.chapters!
  const targetId = afterId ?? doc.activeChapterId
  const idx = targetId ? list.findIndex((c) => c.id === targetId) : -1
  const insertAt = idx >= 0 ? idx + 1 : list.length
  const chapter: Chapter = { id: uid(), title: title ?? `Chapter ${insertAt + 1}`, content: '' }
  list.splice(insertAt, 0, chapter)
  doc.activeChapterId = chapter.id
  doc.content = storyText(doc)
  doc.updatedAt = Date.now()
  return { doc, chapter }
}

/** Rename a chapter (empty titles are permitted; display falls back to "Chapter N"). */
export function renameChapter(doc: StoryDoc, id: string, title: string): StoryDoc {
  if (!isChaptered(doc)) return doc
  const ch = doc.chapters!.find((c) => c.id === id)
  if (!ch) return doc
  ch.title = title.trim()
  doc.updatedAt = Date.now()
  return doc
}

/**
 * Delete a chapter. If it was the last remaining chapter, converts the document back
 * to a non-chaptered story preserving its text. Otherwise activates the neighbor.
 */
export function deleteChapter(doc: StoryDoc, id: string): StoryDoc {
  if (!isChaptered(doc)) return doc
  const list = doc.chapters!
  const idx = list.findIndex((c) => c.id === id)
  if (idx < 0) return doc
  if (list.length === 1) {
    return removeChapters(doc)
  }
  const wasActive = doc.activeChapterId === id
  list.splice(idx, 1)
  if (wasActive) {
    const next = list[idx] ?? list[idx - 1] ?? list[0]
    doc.activeChapterId = next.id
  }
  doc.content = storyText(doc)
  doc.updatedAt = Date.now()
  return doc
}

/** Move a chapter up (`-1`) or down (`1`) in `doc.chapters`. */
export function moveChapter(doc: StoryDoc, id: string, dir: -1 | 1): StoryDoc {
  if (!isChaptered(doc)) return doc
  const list = doc.chapters!
  const idx = list.findIndex((c) => c.id === id)
  if (idx < 0) return doc
  const target = idx + dir
  if (target < 0 || target >= list.length) return doc
  const [item] = list.splice(idx, 1)
  list.splice(target, 0, item)
  doc.content = storyText(doc)
  doc.updatedAt = Date.now()
  return doc
}

/** Reorder a chapter by moving `fromId` to the position of `toId`. */
export function reorderChapter(doc: StoryDoc, fromId: string, toId: string): StoryDoc {
  if (!isChaptered(doc) || fromId === toId) return doc
  const list = doc.chapters!
  const fromIdx = list.findIndex((c) => c.id === fromId)
  const toIdx = list.findIndex((c) => c.id === toId)
  if (fromIdx < 0 || toIdx < 0) return doc
  const [item] = list.splice(fromIdx, 1)
  list.splice(toIdx, 0, item)
  doc.content = storyText(doc)
  doc.updatedAt = Date.now()
  return doc
}

/** Split a chapter at `offset` into two chapters; the new chapter becomes active. */
export function splitChapterAtOffset(
  doc: StoryDoc,
  id: string,
  offset: number,
  newTitle?: string,
): { doc: StoryDoc; chapter: Chapter } | null {
  if (!isChaptered(doc)) return null
  const list = doc.chapters!
  const idx = list.findIndex((c) => c.id === id)
  if (idx < 0) return null
  const ch = list[idx]
  const [before, after] = splitContentAtOffset(ch.content, offset)
  ch.content = before
  const chapter: Chapter = { id: uid(), title: newTitle ?? `Chapter ${idx + 2}`, content: after }
  list.splice(idx + 1, 0, chapter)
  doc.activeChapterId = chapter.id
  doc.content = storyText(doc)
  doc.updatedAt = Date.now()
  return { doc, chapter }
}

/** Map a character offset in `storyText(doc)` back to the chapter containing it. */
export function findChapterByCumulativeOffset(doc: StoryDoc, offset: number): Chapter | null {
  if (!isChaptered(doc)) return null
  const list = doc.chapters!
  let pos = 0
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]
    const end = pos + ch.content.length
    if (offset <= end || i === list.length - 1) return ch
    pos = end + 2 // '\n\n' join separator
  }
  return list[0]
}
