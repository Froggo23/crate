/**
 * Anthropic adapter. Uses the official SDK's structured output support, which
 * constrains generation to the schema rather than asking politely for JSON.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { JsonRequest } from './index';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    client = new Anthropic();
  }
  return client;
}

export function anthropicModel(): string {
  return process.env.ANTHROPIC_CHAT_MODEL ?? 'claude-opus-5';
}

export async function anthropicJson<T>(
  req: JsonRequest<T>,
): Promise<{ raw: unknown; model: string }> {
  const model = anthropicModel();
  const response = await getClient().messages.create({
    timeout: req.timeoutMs,
    model,
    max_tokens: req.maxTokens ?? 8000,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    output_config: {
      format: {
        type: 'json_schema',
        name: req.schemaName,
        schema: req.jsonSchema,
      },
    },
  } as Anthropic.MessageCreateParamsNonStreaming);

  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request (${response.stop_details?.category ?? 'unspecified'})`);
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) throw new Error('Claude returned no text content');
  return { raw: JSON.parse(text), model };
}
