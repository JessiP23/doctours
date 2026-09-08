import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from '@/lib/env';
import { log } from '@/lib/log';
import * as repo from '@/lib/db/repo';
import type { Json } from '@/lib/db/types';
import { withProviderTrace } from '@/lib/providers/trace';
import { isProviderError } from '@/lib/providers/sabre/errors';
import { humanizeBubbles, textToBubbles } from '@/lib/text/humanize';
import type { TripRules } from '@/lib/trip/rules';
import { anthropicTools, getTool } from './tools';
import { checkAnnouncedActions, checkRaisedEvents, checkReferences } from './guard';
import { REPLY_TOOL_NAME, replySchema } from './tools/reply';
import { buildTripState } from './state';
import { buildSystemPrompt } from './system';

/**
 * One user turn = one call to runTurn().
 *
 *  load history ─▶ build state + system ─▶ model (tool_choice: any)
 *       ▲                                         │
 *       │        persist assistant blocks         ▼
 *       └── persist tool_results ◀── run tools ◀──┴── reply? → return bubbles
 *
 * Stateless: everything is read from and written to the DB each turn.
 */
export interface TurnResult {
  bubbles: string[];
  expectsInput: boolean;
  iterations: number;
}

export interface ModelClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

const MAX_ITERATIONS = 8;
/** Identical tool failures tolerated in one turn before the model must stop. */
const MAX_SAME_FAILURE = 2;
const MAX_TOKENS = 1024;

function defaultClient(): ModelClient {
  const anthropic = new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY });
  return { create: (p) => anthropic.messages.create(p) };
}

function asJson(v: unknown): Json {
  return JSON.parse(JSON.stringify(v ?? null)) as Json;
}

async function loadHistory(conversationId: string): Promise<Anthropic.MessageParam[]> {
  const rows = await repo.listMessages(conversationId);
  return rows.map((r) => ({
    role: r.role,
    content: r.content as unknown as Anthropic.MessageParam['content'],
  }));
}

async function runTool(name: string, input: unknown, conversationId: string) {
  const tool = getTool(name);
  const started = Date.now();
  const l = log.child({ conversationId, tool: name });

  if (!tool) {
    const error = { code: 'UNKNOWN_TOOL', message: `No tool named ${name}` };
    await repo.recordToolCall(conversationId, {
      toolName: name,
      input: asJson(input),
      output: null,
      error,
      providerRequests: null,
      durationMs: 0,
    });
    return { ok: false as const, error };
  }

  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    const error = {
      code: 'INVALID_INPUT',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
    l.warn({ error }, 'tool input rejected');
    await repo.recordToolCall(conversationId, {
      toolName: name,
      input: asJson(input),
      output: null,
      error,
      providerRequests: null,
      durationMs: Date.now() - started,
    });
    return { ok: false as const, error };
  }

  try {
    const { result, requests } = await withProviderTrace(() =>
      tool.handler(parsed.data, { conversationId }),
    );
    const durationMs = Date.now() - started;
    l.info({ durationMs, providerRequests: requests }, 'tool ok');
    await repo.recordToolCall(conversationId, {
      toolName: name,
      input: asJson(parsed.data),
      output: asJson(result),
      error: null,
      providerRequests: asJson(requests),
      durationMs,
    });
    return { ok: true as const, result };
  } catch (e) {
    const durationMs = Date.now() - started;
    const error = isProviderError(e)
      ? e.toJSON()
      : { code: 'TOOL_FAILED', message: e instanceof Error ? e.message : String(e) };
    l.error({ error, durationMs }, 'tool failed');
    await repo.recordToolCall(conversationId, {
      toolName: name,
      input: asJson(parsed.data),
      output: null,
      error,
      providerRequests: null,
      durationMs,
    });
    return { ok: false as const, error };
  }
}

export async function runTurn(
  conversationId: string,
  userText: string,
  rules: TripRules,
  deps: { client?: ModelClient; model?: string } = {},
): Promise<TurnResult> {
  const client = deps.client ?? defaultClient();
  const model = deps.model ?? getEnv().ANTHROPIC_MODEL;
  const l = log.child({ conversationId });

  await repo.appendMessage(conversationId, 'user', [{ type: 'text', text: userText }]);
  const history = await loadHistory(conversationId);
  const tools = anthropicTools();
  let referenceRetryUsed = false;
  let promiseNudgeUsed = false;
  let eventNudgeUsed = false;
  /** How often each tool has failed the same way this turn, to stop retry storms. */
  const failureCounts = new Map<string, number>();

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const [bookings, flightOffers, hotelOffers, openEvents] = await Promise.all([
      repo.listBookings(conversationId),
      repo.listRecentOffers(conversationId, 'flight', 6),
      repo.listRecentOffers(conversationId, 'hotel_rate', 6),
      repo.listOpenTripEvents(conversationId),
    ]);
    const state = buildTripState(rules, bookings, [...flightOffers, ...hotelOffers], openEvents);
    const system = buildSystemPrompt(state);

    const response = await client.create({
      model,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools,
      tool_choice: { type: 'any' },
      messages: history,
    });
    l.info({ iteration: i, stop: response.stop_reason, usage: response.usage }, 'model response');

    const assistantContent = response.content as unknown as Json;
    await repo.appendMessage(conversationId, 'assistant', assistantContent);
    history.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    // No tool call at all (shouldn't happen with tool_choice any): humanize free text.
    if (toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n');
      return {
        bubbles: textToBubbles(
          text || 'Give me a second, I lost my train of thought. Could you say that again?',
        ),
        expectsInput: true,
        iterations: i,
      };
    }

    const reply = toolUses.find((t) => t.name === REPLY_TOOL_NAME);
    const others = toolUses.filter((t) => t.name !== REPLY_TOOL_NAME);

    const results: Anthropic.ToolResultBlockParam[] = [];
    const content: Anthropic.ContentBlockParam[] = [];
    let bookedThisTurn = false;
    let searchedThisTurn = false;
    const exhausted: string[] = [];

    for (const t of others) {
      const r = await runTool(t.name, t.input, conversationId);
      if (t.name.startsWith('create_') && r.ok) bookedThisTurn = true;
      if (t.name.startsWith('search_') || t.name.startsWith('get_')) searchedThisTurn = true;
      if (!r.ok) {
        const key = `${t.name}:${(r.error as { code?: string }).code ?? 'error'}`;
        const count = (failureCounts.get(key) ?? 0) + 1;
        failureCounts.set(key, count);
        if (count >= MAX_SAME_FAILURE) exhausted.push(`${t.name} (${key.split(':')[1]})`);
      }
      results.push({
        type: 'tool_result',
        tool_use_id: t.id,
        content: JSON.stringify(r.ok ? r.result : { error: r.error }),
        is_error: !r.ok,
      });
    }

    if (reply) {
      const parsed = replySchema.safeParse(reply.input);
      // Close the tool_use so history stays valid for the next turn.
      results.push({ type: 'tool_result', tool_use_id: reply.id, content: 'delivered' });

      if (parsed.success) {
        const bubbles = humanizeBubbles(parsed.data.bubbles);
        const knownReferences = bookings
          .filter((b) => b.status === 'confirmed')
          .map((b) => b.booking_reference);
        const guard = checkReferences(bubbles, knownReferences);

        if (guard.ok) {
          // A reply that announces a booking without having made one is not delivered:
          // the model is told to either do it or say what it actually needs.
          const promise = checkAnnouncedActions(bubbles, {
            bookedThisTurn,
            searchedThisTurn,
            expectsInput: parsed.data.expectsInput,
          });
          if (!promise.ok && !promiseNudgeUsed) {
            promiseNudgeUsed = true;
            l.warn(
              { announced: promise.announced, iteration: i },
              'reply announced an action it did not take',
            );
            const nudge =
              promise.kind === 'booking'
                ? `You told the patient "${promise.announced}" but you did not call a booking tool in this turn, so nothing was booked. Either call the booking tool now, or reply telling them plainly what you still need from them.`
                : `You told the patient "${promise.announced}" but you did not call the tool that does it, so nothing was looked up and they are waiting on nothing. Call the tool now and reply with what it returns, or ask them the question you actually need answered.`;
            const nudgeBlocks = [...results, { type: 'text' as const, text: nudge }];
            await repo.appendMessage(conversationId, 'user', nudgeBlocks as unknown as Json);
            history.push({ role: 'user', content: nudgeBlocks });
            continue;
          }

          // A change the patient was never told about has to actually be told. If the
          // reply skipped it, say so once and let the model answer again.
          const raised = checkRaisedEvents(
            bubbles,
            openEvents.map((e) => e.kind),
          );
          if (!raised.ok && !eventNudgeUsed) {
            eventNudgeUsed = true;
            l.warn(
              { unraised: raised.unraised, iteration: i },
              'reply did not raise an open event',
            );
            const nudgeBlocks = [
              ...results,
              {
                type: 'text' as const,
                text: `Your reply never mentions the change to this trip (${raised.unraised.join(', ')}). The patient still believes nothing has happened. Reply again, leading with what changed, in your own words, before anything else.`,
              },
            ];
            await repo.appendMessage(conversationId, 'user', nudgeBlocks as unknown as Json);
            history.push({ role: 'user', content: nudgeBlocks });
            continue;
          }

          await repo.appendMessage(conversationId, 'user', results as unknown as Json);
          // Told once is told: otherwise every later turn re-announces the same
          // cancellation and the conversation never moves on.
          if (openEvents.length > 0) {
            await repo.acknowledgeTripEvents(
              conversationId,
              openEvents.map((e) => e.id),
            );
            l.info(
              { raised: openEvents.map((e) => e.kind) },
              'open events raised with the patient',
            );
          }
          return { bubbles, expectsInput: parsed.data.expectsInput, iterations: i };
        }

        // The reply quoted something shaped like a record locator that is not in the
        // bookings table. Never deliver it: correct the model once, then give up safely.
        l.error(
          { violations: guard.violations, iteration: i },
          'reply quoted an unknown booking reference',
        );
        const correction = `You wrote ${guard.violations.join(', ')} as if it were a booking reference, but no booking with that reference exists for this trip. ${
          knownReferences.length
            ? `The only real references are: ${knownReferences.join(', ')}.`
            : 'Nothing has been booked yet.'
        } Never state a reference that is not in the booked state above. Reply again without inventing one.`;
        const correctionBlocks = [...results, { type: 'text' as const, text: correction }];
        await repo.appendMessage(conversationId, 'user', correctionBlocks as unknown as Json);

        if (referenceRetryUsed) {
          return {
            bubbles: [
              'Sorry, I mixed up the booking details there.',
              'Let me re-check where your trip actually stands before I tell you anything else.',
            ],
            expectsInput: true,
            iterations: i,
          };
        }
        referenceRetryUsed = true;
        history.push({ role: 'user', content: correctionBlocks });
        continue;
      }

      await repo.appendMessage(conversationId, 'user', results as unknown as Json);
      l.warn({ issues: parsed.error.issues }, 'reply rejected by schema, falling back');
      const raw = (reply.input as { bubbles?: unknown })?.bubbles;
      const bubbles = Array.isArray(raw)
        ? humanizeBubbles(raw.map(String))
        : ['Sorry, I garbled that. Could you say it again?'];
      return { bubbles, expectsInput: true, iterations: i };
    }

    content.push(...results);
    if (exhausted.length > 0) {
      // Calling a broken tool a third time wastes the patient's time and reads as
      // flailing. Stop, and say something true instead.
      l.warn(
        { exhausted, iteration: i },
        'tool failed repeatedly, telling the model to stop retrying',
      );
      content.push({
        type: 'text',
        text: `${exhausted.join(' and ')} has now failed the same way ${MAX_SAME_FAILURE} times. Do not call it again this turn. Tell the patient plainly that the booking system is refusing this request, that nothing has been charged or booked, and offer to try a different option or come back to it — then end your turn with reply.`,
      });
    }

    await repo.appendMessage(conversationId, 'user', content as unknown as Json);
    history.push({ role: 'user', content });
  }

  l.error('agent loop exhausted without a reply');
  return {
    bubbles: ['I got a bit tangled up there. Could you tell me again what you’d like to do?'],
    expectsInput: true,
    iterations: MAX_ITERATIONS,
  };
}
