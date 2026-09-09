import * as repo from '@/lib/db/repo';
import { buildOptionBoard } from '@/lib/agent/board';
import { getOrCreateConversation } from '@/lib/agent/conversation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/conversation/board → the options currently on the table for the open
 * trip, laid out for side-by-side comparison. Read from the same offers the agent
 * has already shown; nothing is searched or priced here.
 */
export async function GET() {
  const conversation = await getOrCreateConversation();
  if (conversation.isNew) return Response.json({ board: null });
  const [bookings, flights, rooms, hotels] = await Promise.all([
    repo.listBookings(conversation.id),
    repo.listRecentOffers(conversation.id, 'flight', 12),
    repo.listRecentOffers(conversation.id, 'hotel_rate', 6),
    repo.listRecentOffers(conversation.id, 'hotel_property', 6),
  ]);
  const board = buildOptionBoard(conversation.rules, bookings, [...flights, ...rooms, ...hotels]);
  return Response.json({ board });
}
