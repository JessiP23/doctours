import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, toAnthropicTool } from '@/lib/agent/tools/define';
import { anthropicTools, getTool } from '@/lib/agent/tools';
import { replySchema } from '@/lib/agent/tools/reply';

describe('tool registry', () => {
  it('exposes reply as an Anthropic tool with an object schema', () => {
    const tools = anthropicTools();
    const reply = tools.find((t) => t.name === 'reply');
    expect(reply).toBeDefined();
    expect(reply?.input_schema.type).toBe('object');
    expect((reply?.input_schema as { required?: string[] }).required).toEqual([
      'bubbles',
      'expectsInput',
    ]);
    expect(getTool('reply')).toBeDefined();
  });

  it('converts a zod schema with descriptions and enums', () => {
    const t = defineTool({
      name: 'demo',
      description: 'demo',
      schema: z.object({
        direction: z.enum(['outbound', 'return']).describe('which way'),
        n: z.number().int().optional(),
      }),
      handler: async (i) => i,
    });
    const a = toAnthropicTool(t);
    const props = (
      a.input_schema as { properties: Record<string, { enum?: string[]; description?: string }> }
    ).properties;
    expect(props.direction.enum).toEqual(['outbound', 'return']);
    expect(props.direction.description).toBe('which way');
    expect(a.input_schema).not.toHaveProperty('$schema');
  });
});

describe('replySchema', () => {
  it('rejects more than 4 bubbles and empty strings', () => {
    expect(
      replySchema.safeParse({ bubbles: ['a', 'b', 'c', 'd', 'e'], expectsInput: false }).success,
    ).toBe(false);
    expect(replySchema.safeParse({ bubbles: [''], expectsInput: false }).success).toBe(false);
    expect(replySchema.safeParse({ bubbles: ['Hi!'], expectsInput: true }).success).toBe(true);
  });
});
