import * as repo from '@/lib/db/repo';
import type { TripRules } from '@/lib/trip/rules';

/**
 * The rules a tool must obey, read from the conversation's own snapshot rather
 * than a module constant — so a trip booked under different rules stays correct.
 */
export async function rulesFor(conversationId: string): Promise<TripRules> {
  const conversation = await repo.getConversation(conversationId);
  if (!conversation) throw new Error(`Conversation ${conversationId} not found`);
  return conversation.trip_rules as unknown as TripRules;
}
