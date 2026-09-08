import { z } from 'zod';
import { MAX_BUBBLES, MAX_BUBBLE_CHARS, textToBubbles } from '@/lib/text/humanize';
import { defineTool } from './define';

/**
 * Terminal tool. The model must end every turn by calling this. The loop does
 * not execute a handler for it — it validates, humanizes and returns the bubbles.
 * Keeping it as a tool (rather than free text) makes "short, plain, 1–4 bubbles"
 * a schema constraint instead of a hope.
 */
export const REPLY_TOOL_NAME = 'reply';

export const replySchema = z.object({
  bubbles: z
    .array(
      z
        .string()
        .min(1)
        .max(MAX_BUBBLE_CHARS * 2),
    )
    .min(1)
    .max(MAX_BUBBLES)
    .describe(
      `Short plain-text messages sent one after another, like texting. ${MAX_BUBBLES} max, each under ${MAX_BUBBLE_CHARS} characters. No markdown, no lists, no headers, no emojis.`,
    ),
  expectsInput: z
    .boolean()
    .describe(
      'true if you are waiting for the user to answer something; false if you just informed them.',
    ),
});

export type ReplyInput = z.infer<typeof replySchema>;

/**
 * The model is told `bubbles` is an array of strings and mostly sends one. Now and
 * then it sends the array as a JSON string, or just sends the prose. That is a
 * usable reply in the wrong wrapper, and throwing it away cost a patient a real
 * answer — the app said "Sorry, I garbled that" while a perfectly good sentence sat
 * in the tool call.
 *
 * So the tool schema stays strict (it is what the model reads, and an array is what
 * we want it to send) and parsing is tolerant: unwrap a stringified array, treat
 * loose prose as text to split, accept "true"/"false" for the boolean.
 */
export function normalizeReplyInput(input: unknown): { value: unknown; coerced: string[] } {
  if (typeof input !== 'object' || input === null) return { value: input, coerced: [] };
  const raw = { ...(input as Record<string, unknown>) };
  const coerced: string[] = [];

  if (typeof raw.bubbles === 'string') {
    const text = raw.bubbles.trim();
    let unwrapped: string[] | null = null;
    if (text.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.every((b) => typeof b === 'string')) {
          unwrapped = parsed as string[];
        }
      } catch {
        // Not JSON after all; fall through and treat it as prose.
      }
    }
    raw.bubbles = unwrapped ?? textToBubbles(raw.bubbles);
    coerced.push(unwrapped ? 'bubbles: stringified array' : 'bubbles: prose split into bubbles');
  }

  if (typeof raw.expectsInput === 'string') {
    const flag = raw.expectsInput.trim().toLowerCase();
    if (flag === 'true' || flag === 'false') {
      raw.expectsInput = flag === 'true';
      coerced.push('expectsInput: string');
    }
  }

  return { value: raw, coerced };
}

/** Validates a reply tool call, repairing the shapes the model gets wrong. */
export function parseReplyInput(input: unknown) {
  const { value, coerced } = normalizeReplyInput(input);
  return { ...replySchema.safeParse(value), coerced };
}

export const replyTool = defineTool({
  name: REPLY_TOOL_NAME,
  description:
    'Send your reply to the user and end your turn. Always finish with this. Write like a warm, competent human coordinator texting: one idea per bubble, first bubble is the point, contractions are fine, prices like $742, times like 6:40 pm local.',
  schema: replySchema,
  handler: async (input) => input,
});
