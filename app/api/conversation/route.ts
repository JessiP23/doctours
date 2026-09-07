import {
  getOrCreateConversation,
  loadTranscript,
  switchConversation,
} from '@/lib/agent/conversation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/conversation → the open trip and its transcript. Hydrates the chat. */
export async function GET() {
  const conversation = await getOrCreateConversation();
  const messages = conversation.isNew ? [] : await loadTranscript(conversation.id);
  return Response.json({ conversationId: conversation.id, messages });
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
