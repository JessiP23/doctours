import { z } from 'zod';
import { MAX_BUBBLES, MAX_BUBBLE_CHARS } from '@/lib/text/humanize';
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

export const replyTool = defineTool({
  name: REPLY_TOOL_NAME,
  description:
    'Send your reply to the user and end your turn. Always finish with this. Write like a warm, competent human coordinator texting: one idea per bubble, first bubble is the point, contractions are fine, prices like $742, times like 6:40 pm local.',
  schema: replySchema,
  handler: async (input) => input,
});
