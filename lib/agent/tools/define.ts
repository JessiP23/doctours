import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * Tool definition contract.
 *
 * A tool is a Zod input schema + a handler. The schema is the single source of
 * truth: it validates what the model sends AND is converted to the JSON schema
 * the model sees. Handlers receive a per-turn context so they never reach for
 * globals; they return plain JSON the model can read.
 */
export interface ToolContext {
  conversationId: string;
}

export interface ToolDefinition<TInput extends z.ZodType = z.ZodType, TOutput = unknown> {
  name: string;
  description: string;
  schema: TInput;
  handler: (input: z.infer<TInput>, ctx: ToolContext) => Promise<TOutput>;
}

export function defineTool<TInput extends z.ZodType, TOutput>(
  def: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  return def;
}

/** Converts a tool definition to the shape the Anthropic Messages API expects. */
export function toAnthropicTool(def: ToolDefinition): Anthropic.Tool {
  const json = z.toJSONSchema(def.schema, { target: 'draft-7', io: 'input' }) as Record<
    string,
    unknown
  >;
  // Anthropic requires an object schema; strip the $schema key Zod adds.
  delete json.$schema;
  return {
    name: def.name,
    description: def.description,
    input_schema: json as Anthropic.Tool.InputSchema,
  };
}
