// OpenAI-compatible chat client: model listing + SSE streaming completions.
// Works with llama.cpp, LM Studio, KoboldCpp, Unsloth Desktop, vLLM, cloud APIs...

import type { ModelInfo, SamplingParams } from './types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamCallbacks {
  /** Called for each streamed content delta (already filtered to visible text). */
  onToken: (text: string) => void
  /** Some servers report usage in the final chunk. */
  onUsage?: (usage: { prompt_tokens?: number; completion_tokens?: number }) => void
}

export function normalizeBaseUrl(base: string): string {
  let u = base.trim().replace(/\/+$/, '')
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) {
    u = `http://${u}`
  }
  return u
}

function authHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey && apiKey.trim()) h.Authorization = `Bearer ${apiKey.trim()}`
  return h
}

export async function listModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, {
    headers: authHeaders(apiKey),
    referrerPolicy: 'no-referrer',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await safeText(res)).slice(0, 200)}`)
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> }
  const data = Array.isArray(json.data) ? json.data : []
  return data.map((m) => ({
    id: String(m.id ?? ''),
    contextLength: typeof m.context_length === 'number' ? (m.context_length as number)
      : typeof m.max_context_length === 'number' ? (m.max_context_length as number)
      : undefined,
    loaded: m.loaded === true,
  })).filter((m) => m.id)
}

export interface StreamResult {
  text: string
  promptTokens?: number
  completionTokens?: number
}

/**
 * Stream a chat completion. Returns the full generated text.
 * Throws on HTTP errors or if the stream ends without [DONE] (partial text is still returned on abort).
 */
export async function chatStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  params: SamplingParams,
  signal: AbortSignal,
  cb: StreamCallbacks,
): Promise<StreamResult> {
  const body: Record<string, unknown> = { model, messages, stream: true }
  if (typeof params.temperature === 'number' && Number.isFinite(params.temperature)) body.temperature = params.temperature
  if (typeof params.topP === 'number' && Number.isFinite(params.topP)) body.top_p = params.topP
  if (params.maxTokens > 0) body.max_tokens = params.maxTokens
  if (params.stopSequences.length > 0) body.stop = params.stopSequences

  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    referrerPolicy: 'no-referrer',
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${(await safeText(res)).slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let full = ''
  let promptTokens: number | undefined
  let completionTokens: number | undefined

  const handleLine = (raw: string): boolean => {
    const line = raw.trim()
    if (!line || line.startsWith(':')) return false // keep-alive / comment
    if (!line.startsWith('data:')) return false
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') return true
    try {
      const json = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      // Only visible text goes into the document — thinking models may also stream
      // `reasoning_content`, which we deliberately ignore.
      const delta = json.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta.length > 0) {
        full += delta
        cb.onToken(delta)
      }
      if (json.usage) {
        promptTokens = json.usage.prompt_tokens ?? promptTokens
        completionTokens = json.usage.completion_tokens ?? completionTokens
        cb.onUsage?.(json.usage)
      }
    } catch {
      // partial or non-JSON line — ignore
    }
    return false
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (handleLine(line)) return { text: full, promptTokens, completionTokens }
      }
    }
    // stream closed without [DONE] — flush any trailing line
    if (buf.trim()) handleLine(buf)
    return { text: full, promptTokens, completionTokens }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
