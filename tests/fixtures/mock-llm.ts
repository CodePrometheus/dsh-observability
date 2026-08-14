/**
 * Keyless mock adapter for the REAL-composition e2e: one real bash tool round
 * trip followed by a final answer, with fixed token usage so the exported step
 * spans carry deterministic `gen_ai.usage.*` values. Both requests report all
 * five usage fields, which is what lets the e2e assert that cache-write tokens
 * reach the wire and not only cache reads.
 *
 * Erasable-syntax TypeScript only: the Loader runs this file under plain Node
 * type stripping in `lib` mode.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const OFF = ReasoningEffortId('off')

/** Marker the bash round trip prints, asserted on the exported tool span. */
export const TOOL_MARKER = 'OBSERVABILITY_TOOL_ROUND_TRIP'

/** Call id of the single tool call, so the e2e can address its span. */
const CALL_ID = CallId('observability-e2e-call')

class ObservabilityMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: OFF, name: 'Off' }],
        defaultEffort: OFF,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const toolResult = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (toolResult === undefined) {
      const args = JSON.stringify({ command: `printf ${TOOL_MARKER}`, description: 'Prove the tool round trip.' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CALL_ID, name: 'bash', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CALL_ID, name: 'bash', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 5, reasoningTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const toolText = toolResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `Tool round trip complete: ${toolText.trim()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'observability-mock-llm'
export const inject = ['llm']

/**
 * Register the keyless `observability-mock` adapter.
 * @param ctx - Cordis context carrying the LLM service.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['observability-mock'], new ObservabilityMockAdapter())
}
