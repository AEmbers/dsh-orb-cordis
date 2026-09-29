/**
 * Queued LLM adapter for loop tests.
 * The fork kept this under core/agent-loop; this package vendors the subset the Computer Use loop uses.
 */

import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

export class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private cursor = 0

  constructor(private readonly responses: readonly (readonly StreamChunk[])[]) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.responses[this.cursor] ?? []
    this.cursor += 1
    for (const chunk of chunks) yield chunk
  }
}

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function toolCallResponse(id: string, name: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: ToolCallId(id),
        name,
        arguments: JSON.stringify(args),
      },
    },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
