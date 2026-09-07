import {
  getOrCreateConversation,
  loadTranscript,
  resetConversation,
} from '@/lib/agent/conversation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/conversation → { conversationId, messages } — hydrates the chat after a refresh. */
export async function GET() {
  const conversation = await getOrCreateConversation();
  const messages = conversation.isNew ? [] : await loadTranscript(conversation.id);
  return Response.json({ conversationId: conversation.id, messages });
}

/** DELETE /api/conversation → starts a fresh trip (new cookie). Used by the "start over" affordance. */
export async function DELETE() {
  const conversation = await resetConversation();
  return Response.json({ conversationId: conversation.id, messages: [] });
}
