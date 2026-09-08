import {
  getOrCreateConversation,
  hasPendingUpdate,
  loadTranscript,
  switchConversation,
} from '@/lib/agent/conversation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/conversation → the open trip, its transcript, and whether an update is
 * on its way. Hydrates the chat, and is polled while the chat is idle so a message
 * the agent sends on its own — a cancellation it just learned about — appears
 * without the patient having to say something first.
 */
export async function GET() {
  const conversation = await getOrCreateConversation();
  const [messages, pendingUpdate] = conversation.isNew
    ? [[], false]
    : await Promise.all([loadTranscript(conversation.id), hasPendingUpdate(conversation.id)]);
  return Response.json({ conversationId: conversation.id, messages, pendingUpdate });
}

/** PUT /api/conversation { conversationId } → opens one of this browser's other trips. */
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { conversationId?: string } | null;
  if (!body?.conversationId) {
    return Response.json({ error: 'conversationId is required' }, { status: 400 });
  }
  const conversation = await switchConversation(body.conversationId);
  if (!conversation) return Response.json({ error: 'No such trip' }, { status: 404 });
  return Response.json({
    conversationId: conversation.id,
    messages: await loadTranscript(conversation.id),
  });
}
