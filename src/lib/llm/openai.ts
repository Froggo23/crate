/**
 * OpenAI adapter. `response_format: json_schema` with `strict: true` gives the
 * same guarantee as the Anthropic path: the model cannot emit a shape that does
 * not validate.
 */

import { fetchWithRetry } from '../net';
import type { JsonRequest } from './index';

export function openaiModel(): string {
  return process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o';
}

interface ChatResponse {
  choices: { message: { content: string | null; refusal?: string | null } }[];
}

export async function openaiJson<T>(
  req: JsonRequest<T>,
): Promise<{ raw: unknown; model: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const model = openaiModel();

  const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    timeoutMs: req.timeoutMs ?? 90_000,
    retries: req.retries,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_completion_tokens: req.maxTokens ?? 8000,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: req.schemaName, strict: true, schema: req.jsonSchema },
      },
    }),
  });

  const json = (await res.json()) as ChatResponse;
  const choice = json.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`OpenAI refused: ${choice.message.refusal}`);
  const content = choice?.message?.content;
  if (!content) throw new Error('OpenAI returned no content');
  return { raw: JSON.parse(content), model };
}
