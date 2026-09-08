import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

// In-memory stand-in for the Supabase repository.
const mem = {
  messages: [] as { role: string; content: unknown }[],
  toolCalls: [] as { toolName: string; error: unknown }[],
  bookings: [] as { kind: string; status: string; booking_reference: string }[],
  openEvents: [] as { id: string; kind: string; detail: unknown }[],
  acknowledged: [] as string[],
};
vi.mock('@/lib/db/repo', () => ({
  appendMessage: vi.fn(async (_c: string, role: string, content: unknown) => {
    mem.messages.push({ role, content });
    return { id: mem.messages.length, role, content };
  }),
  listMessages: vi.fn(async () =>
    mem.messages.map((m, i) => ({ id: i + 1, role: m.role, content: m.content })),
  ),
  listBookings: vi.fn(async () => mem.bookings),
  listRecentOffers: vi.fn(async () => []),
  listOpenTripEvents: vi.fn(async () => mem.openEvents),
  acknowledgeTripEvents: vi.fn(async (_c: string, ids: string[]) => {
    mem.acknowledged.push(...ids);
    mem.openEvents = mem.openEvents.filter((e) => !ids.includes(e.id));
  }),
  recordToolCall: vi.fn(async (_c: string, t: { toolName: string; error: unknown }) => {
    mem.toolCalls.push(t);
    return t;
  }),
}));

import { runTurn, type ModelClient } from '@/lib/agent/loop';
import { registerTools } from '@/lib/agent/tools';
import { defineTool } from '@/lib/agent/tools/define';
import { TRIP_RULES } from '@/lib/trip/rules';

registerTools(
  defineTool({
    name: 'echo',
    description: 'echo',
    schema: z.object({ value: z.string() }),
    handler: async (i) => ({ echoed: i.value }),
  }),
  defineTool({
    name: 'explode',
    description: 'explode',
    schema: z.object({}),
    handler: async () => {
      throw new Error('boom');
    },
  }),
);

function msg(content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as Anthropic.Message;
}
const use = (id: string, name: string, input: unknown) =>
  ({ type: 'tool_use', id, name, input }) as Anthropic.ToolUseBlock;

function scripted(
  responses: Anthropic.Message[],
): ModelClient & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    create: async (p) => {
      calls.push(structuredClone(p)); // snapshot: the loop mutates its history array
      const next = responses.shift();
      if (!next) throw new Error('no scripted response left');
      return next;
    },
  };
}

beforeEach(() => {
  mem.messages = [];
  mem.toolCalls = [];
  mem.bookings = [];
  mem.openEvents = [];
  mem.acknowledged = [];
});

describe('runTurn', () => {
  it('returns humanized bubbles from the reply tool and persists the exchange', async () => {
    const client = scripted([
      msg([use('t1', 'reply', { bubbles: ['**Hi!**', 'Ready to book?'], expectsInput: true })]),
    ]);
    const r = await runTurn('c1', 'hello', TRIP_RULES, { client, model: 'test' });
    expect(r.bubbles).toEqual(['Hi!', 'Ready to book?']);
    expect(r.expectsInput).toBe(true);
    expect(r.iterations).toBe(1);
    expect(mem.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']); // user, assistant tool_use, tool_result closing reply
    expect(client.calls[0].tool_choice).toEqual({ type: 'any' });
    expect(client.calls[0].system?.[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
  });

  it('executes tools, feeds results back, then replies', async () => {
    const client = scripted([
      msg([use('t1', 'echo', { value: 'ping' })]),
      msg([use('t2', 'reply', { bubbles: ['Got ping.'], expectsInput: false })]),
    ]);
    const r = await runTurn('c1', 'echo ping', TRIP_RULES, { client, model: 'test' });
    expect(r.bubbles).toEqual(['Got ping.']);
    expect(r.iterations).toBe(2);
    const second = client.calls[1].messages;
    const toolResult = second[second.length - 1].content as Anthropic.ToolResultBlockParam[];
    expect(toolResult[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
      is_error: false,
    });
    expect(JSON.parse(toolResult[0].content as string)).toEqual({ echoed: 'ping' });
    expect(mem.toolCalls).toHaveLength(1);
  });

  it('reports invalid input and handler failures as tool errors instead of crashing', async () => {
    const client = scripted([
      msg([use('t1', 'echo', { wrong: 1 }), use('t2', 'explode', {}), use('t3', 'nope', {})]),
      msg([
        use('t4', 'reply', {
          bubbles: ['Something went wrong, trying again.'],
          expectsInput: false,
        }),
      ]),
    ]);
    const r = await runTurn('c1', 'x', TRIP_RULES, { client, model: 'test' });
    expect(r.bubbles).toHaveLength(1);
    const results = client.calls[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(results.map((x) => x.is_error)).toEqual([true, true, true]);
    expect(JSON.parse(results[0].content as string).error.code).toBe('INVALID_INPUT');
    expect(JSON.parse(results[1].content as string).error.code).toBe('TOOL_FAILED');
    expect(JSON.parse(results[2].content as string).error.code).toBe('UNKNOWN_TOOL');
  });

  it('falls back to humanized free text if the model does not call a tool', async () => {
    const client = scripted([
      msg([
        {
          type: 'text',
          text: '# Hello\n\nI can help. Ready?',
          citations: null,
        } as Anthropic.TextBlock,
      ]),
    ]);
    const r = await runTurn('c1', 'x', TRIP_RULES, { client, model: 'test' });
    expect(r.bubbles).toEqual(['Hello', 'I can help. Ready?']);
  });

  it('never delivers a fabricated booking reference: corrects the model, then delivers the corrected reply', async () => {
    const client = scripted([
      msg([
        use('t1', 'reply', {
          bubbles: ['All booked! Your reference is XYZ789.'],
          expectsInput: false,
        }),
      ]),
      msg([
        use('t2', 'reply', {
          bubbles: ['Sorry, nothing is booked yet. Want me to look for flights?'],
          expectsInput: true,
        }),
      ]),
    ]);
    const r = await runTurn('c1', 'did you book it?', TRIP_RULES, { client, model: 'test' });
    expect(r.bubbles.join(' ')).not.toContain('XYZ789');
    expect(r.bubbles[0]).toContain('nothing is booked yet');
    expect(r.iterations).toBe(2);
    // the model was told what it did wrong
    const correction = JSON.stringify(client.calls[1].messages.at(-1)!.content);
    expect(correction).toContain('XYZ789');
    expect(correction).toContain('Nothing has been booked yet');
  });

  it('allows a reference that exists in the bookings table', async () => {
    mem.bookings = [{ kind: 'flight', status: 'confirmed', booking_reference: 'ABC12D' }];
    const client = scripted([
      msg([
        use('t1', 'reply', { bubbles: ['You’re set, reference ABC12D.'], expectsInput: false }),
      ]),
    ]);
    const r = await runTurn('c1', 'reference?', TRIP_RULES, { client, model: 'test' });
    expect(r.bubbles[0]).toContain('ABC12D');
    expect(r.iterations).toBe(1);
  });

  it('gives up safely if the model invents a reference twice', async () => {
    const client = scripted([
      msg([use('t1', 'reply', { bubbles: ['Booked, ref QWE123.'], expectsInput: false })]),
      msg([use('t2', 'reply', { bubbles: ['Sorry, ref RTY456.'], expectsInput: false })]),
    ]);
    const r = await runTurn('c1', 'x', TRIP_RULES, { client, model: 'test' });
    const text = r.bubbles.join(' ');
    expect(text).not.toContain('QWE123');
    expect(text).not.toContain('RTY456');
    expect(text).toContain('mixed up');
  });

  it('injects live state into the system prompt', async () => {
    const client = scripted([msg([use('t1', 'reply', { bubbles: ['ok'], expectsInput: false })])]);
    await runTurn('c1', 'x', TRIP_RULES, { client, model: 'test' });
    const system = (client.calls[0].system as Anthropic.TextBlockParam[])[0].text;
    expect(system).toContain('Flight: not booked yet.');
    expect(system).toContain('Next thing to sort out: flight');
    expect(system).toContain('Monday 12 October at 8:00 PM');
  });

  it('will not deliver a reply that ignores a cancellation the patient was never told about', async () => {
    mem.openEvents = [{ id: 'e1', kind: 'flight_cancelled', detail: {} }];
    const client = scripted([
      msg([
        use('t1', 'reply', {
          bubbles: ['You land at 11:55 am local on the 12th.'],
          expectsInput: true,
        }),
      ]),
      msg([
        use('t2', 'reply', {
          bubbles: [
            'Before that — Qatar cancelled your outbound flight.',
            'You were due to land 11:55 am on the 12th. I am finding you another way in.',
          ],
          expectsInput: true,
        }),
      ]),
    ]);

    const result = await runTurn('c1', 'what time do I land?', TRIP_RULES, {
      client,
      model: 'test',
    });
    expect(result.bubbles[0]).toMatch(/cancelled/i);
    expect(result.iterations).toBe(2);
    // The nudge names the kind so the model knows what it skipped.
    expect(JSON.stringify(mem.messages)).toMatch(/never mentions the change/);
  });

  it('marks an event told once it has been raised, so the next turn does not repeat it', async () => {
    mem.openEvents = [{ id: 'e1', kind: 'flight_cancelled', detail: {} }];
    const client = scripted([
      msg([
        use('t1', 'reply', {
          bubbles: ['Qatar cancelled your outbound flight, so I need to get you rebooked.'],
          expectsInput: true,
        }),
      ]),
    ]);

    await runTurn('c1', 'hi', TRIP_RULES, { client, model: 'test' });
    expect(mem.acknowledged).toEqual(['e1']);
    expect(mem.openEvents).toEqual([]);
  });

  it('delivers normally when there is nothing untold', async () => {
    const client = scripted([
      msg([use('t1', 'reply', { bubbles: ['You land at 11:55 am.'], expectsInput: true })]),
    ]);
    const result = await runTurn('c1', 'what time do I land?', TRIP_RULES, {
      client,
      model: 'test',
    });
    expect(result.iterations).toBe(1);
    expect(mem.acknowledged).toEqual([]);
  });
});
