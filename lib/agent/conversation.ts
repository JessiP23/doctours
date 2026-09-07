import 'server-only';
import { cookies } from 'next/headers';
import * as repo from '@/lib/db/repo';
import type { Json } from '@/lib/db/types';
import { TRIP_RULES, type TripRules } from '@/lib/trip/rules';
import { REPLY_TOOL_NAME } from './tools/reply';

/**
 * Conversation identity and transcript projection.
 *
 * Identity is a httpOnly cookie holding the conversation id — no accounts at
 * Level 0. The transcript shown to the user is derived from the stored raw
 * Anthropic blocks: user text blocks and the bubbles of every reply tool call.
 */
export const CONVERSATION_COOKIE = 'doctours_conversation';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export interface ConversationHandle {
  id: string;
  rules: TripRules;
  isNew: boolean;
}

export async function getOrCreateConversation(): Promise<ConversationHandle> {
  const jar = await cookies();
  const existing = jar.get(CONVERSATION_COOKIE)?.value;
  if (existing) {
    const row = await repo.getConversation(existing);
    if (row) return { id: row.id, rules: row.trip_rules as unknown as TripRules, isNew: false };
  }
  const row = await repo.createConversation(TRIP_RULES as unknown as Json);
  jar.set(CONVERSATION_COOKIE, row.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
  return { id: row.id, rules: TRIP_RULES, isNew: true };
}

export async function resetConversation(): Promise<ConversationHandle> {
  const jar = await cookies();
  const row = await repo.createConversation(TRIP_RULES as unknown as Json);
  jar.set(CONVERSATION_COOKIE, row.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
  return { id: row.id, rules: TRIP_RULES, isNew: true };
}

export interface TranscriptItem {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

type Block = { type: string; text?: string; name?: string; input?: { bubbles?: unknown } };

/** Projects raw stored blocks into what a human should see. Tool plumbing is hidden. */
export function projectTranscript(
  rows: { id: number; role: 'user' | 'assistant'; content: unknown; created_at: string }[],
): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const row of rows) {
    const blocks = Array.isArray(row.content) ? (row.content as Block[]) : [];
    if (row.role === 'user') {
      for (const [i, b] of blocks.entries()) {
        if (b.type === 'text' && b.text?.trim())
          out.push({ id: `${row.id}-${i}`, role: 'user', text: b.text, at: row.created_at });
      }
    } else {
      for (const [i, b] of blocks.entries()) {
        if (
          b.type === 'tool_use' &&
          b.name === REPLY_TOOL_NAME &&
          Array.isArray(b.input?.bubbles)
        ) {
          for (const [j, bubble] of (b.input!.bubbles as unknown[]).entries()) {
            if (typeof bubble === 'string' && bubble.trim())
              out.push({
                id: `${row.id}-${i}-${j}`,
                role: 'assistant',
                text: bubble,
                at: row.created_at,
              });
          }
        }
      }
    }
  }
  return out;
}

export async function loadTranscript(conversationId: string): Promise<TranscriptItem[]> {
  const rows = await repo.listMessages(conversationId);
  return projectTranscript(rows);
}
