import { listTrips, startNewConversation } from '@/lib/agent/conversation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/conversations → every trip this browser has started, newest first. */
export async function GET() {
  return Response.json({ trips: await listTrips() });
}

/** POST /api/conversations → starts a fresh trip and opens it. */
export async function POST() {
  const conversation = await startNewConversation();
  return Response.json({ conversationId: conversation.id, messages: [] });
}
