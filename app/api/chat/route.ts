import { z } from 'zod';
import { runTurn } from '@/lib/agent/loop';
import { getOrCreateConversation } from '@/lib/agent/conversation';
import { log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const bodySchema = z.object({ text: z.string().trim().min(1).max(2000) });

/**
 * POST /api/chat { text } → { conversationId, bubbles, expectsInput }
 * One user turn. Not streamed on purpose: the reply is a list of short bubbles
 * the client reveals one at a time.
 */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'text is required' }, { status: 400 });

  const conversation = await getOrCreateConversation();
  const started = Date.now();
  try {
    const result = await runTurn(conversation.id, parsed.data.text, conversation.rules);
    log.info(
      { conversationId: conversation.id, ms: Date.now() - started, iterations: result.iterations },
      'turn complete',
    );
    return Response.json({
      conversationId: conversation.id,
      bubbles: result.bubbles,
      expectsInput: result.expectsInput,
    });
  } catch (e) {
    log.error(
      { conversationId: conversation.id, err: e instanceof Error ? e.message : String(e) },
      'turn failed',
    );
    return Response.json(
      {
        conversationId: conversation.id,
        bubbles: [
          'Sorry, something on my side just hiccuped.',
          'Give me a moment and try that again?',
        ],
        expectsInput: true,
      },
      { status: 200 },
    );
  }
}
