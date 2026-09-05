/**
 * Provider-agnostic structured-output client.
 *
 * Both adapters are real and interchangeable. Selection is by LLM_PROVIDER, or
 * automatic: an Anthropic key wins if present, otherwise OpenAI. The contract is
 * the same either way -- give it a JSON Schema and a zod validator, get back a
 * validated object -- so swapping providers is an environment variable, not a
 * code change.
 */

import type { z } from 'zod';

export type Provider = 'anthropic' | 'openai';

export interface JsonRequest<T> {
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: object;
  validator: z.ZodType<T>;
  maxTokens?: number;
}

export interface JsonResult<T> {
  data: T;
  provider: Provider;
  model: string;
  ms: number;
}

export function activeProvider(): Provider {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai') return explicit;
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai';
}

export function providerConfigured(): boolean {
  return activeProvider() === 'anthropic'
    ? Boolean(process.env.ANTHROPIC_API_KEY)
    : Boolean(process.env.OPENAI_API_KEY);
}

export async function completeJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
  const provider = activeProvider();
  const t0 = Date.now();
  const { raw, model } = provider === 'anthropic'
    ? await (await import('./anthropic')).anthropicJson(req)
    : await (await import('./openai')).openaiJson(req);

  const parsed = req.validator.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${provider} returned JSON that failed validation: ${JSON.stringify(parsed.error.issues.slice(0, 4))}`,
    );
  }
  return { data: parsed.data, provider, model, ms: Date.now() - t0 };
}
