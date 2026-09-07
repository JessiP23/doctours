import 'server-only';
import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import * as repo from '@/lib/db/repo';
import type { BookingRow, Json } from '@/lib/db/types';
import { TRIP_RULES, type TripRules } from '@/lib/trip/rules';
import { REPLY_TOOL_NAME } from './tools/reply';

/**
 * Conversation identity and the trip list.
 *
 * There are no accounts at Level 0. A httpOnly "visitor" cookie owns the trips
 * created by this browser, and a second cookie remembers which of them is open.
 * Replacing the visitor id with a real user id is the whole of what auth would
 * change here.
 */
export const CONVERSATION_COOKIE = 'doctours_conversation';
export const VISITOR_COOKIE = 'doctours_visitor';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: COOKIE_MAX_AGE,
} as const;

export interface ConversationHandle {
  id: string;
  rules: TripRules;
  isNew: boolean;
}

async function visitorId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(VISITOR_COOKIE)?.value;
  if (existing) return existing;
  const id = randomUUID();
  jar.set(VISITOR_COOKIE, id, cookieOptions);
  return id;
}

async function open(conversationId: string): Promise<void> {
  (await cookies()).set(CONVERSATION_COOKIE, conversationId, cookieOptions);
}

export async function getOrCreateConversation(): Promise<ConversationHandle> {
  const jar = await cookies();
  const current = jar.get(CONVERSATION_COOKIE)?.value;

  if (current) {
    const row = await repo.getConversation(current);
    if (row) return { id: row.id, rules: row.trip_rules as unknown as TripRules, isNew: false };
  }
  return startNewConversation();
}

/** Begins a fresh trip and opens it. */
export async function startNewConversation(): Promise<ConversationHandle> {
  const visitor = await visitorId();
  const row = await repo.createConversation(TRIP_RULES as unknown as Json, visitor);
  await open(row.id);
  return { id: row.id, rules: TRIP_RULES, isNew: true };
}

/** Opens an existing trip, but only one this browser created. */
export async function switchConversation(
  conversationId: string,
): Promise<ConversationHandle | null> {
  const visitor = await visitorId();
  const row = await repo.getConversationForVisitor(conversationId, visitor);
  if (!row) return null;
  await open(row.id);
  return { id: row.id, rules: row.trip_rules as unknown as TripRules, isNew: false };
}

export interface TripSummary {
  id: string;
  createdAt: string;
  isCurrent: boolean;
  /** What has been booked, so the list reads like progress rather than ids. */
  status: 'not started' | 'flight booked' | 'hotel booked' | 'fully booked';
  references: string[];
}

function statusOf(bookings: BookingRow[]): TripSummary['status'] {
  const hasFlight = bookings.some((b) => b.kind === 'flight');
  const hasHotel = bookings.some((b) => b.kind === 'hotel');
  if (hasFlight && hasHotel) return 'fully booked';
  if (hasFlight) return 'flight booked';
  if (hasHotel) return 'hotel booked';
  return 'not started';
}

/** Exposed for unit tests; the status logic is what makes the list readable. */
export const statusOfForTests = statusOf;

export async function listTrips(): Promise<TripSummary[]> {
  const visitor = await visitorId();
  const jar = await cookies();
  const current = jar.get(CONVERSATION_COOKIE)?.value;

  const conversations = await repo.listConversationsForVisitor(visitor);
  const bookings = await repo.listBookingsForConversations(conversations.map((c) => c.id));
  const byConversation = new Map<string, BookingRow[]>();
  for (const booking of bookings) {
    const list = byConversation.get(booking.conversation_id) ?? [];
    list.push(booking);
    byConversation.set(booking.conversation_id, list);
  }

  return conversations.map((conversation) => {
    const own = byConversation.get(conversation.id) ?? [];
    return {
      id: conversation.id,
      createdAt: conversation.created_at,
      isCurrent: conversation.id === current,
      status: statusOf(own),
      references: own.map((b) => b.booking_reference),
    };
  });
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
        if (b.type === 'text' && b.text?.trim()) {
          out.push({ id: `${row.id}-${i}`, role: 'user', text: b.text, at: row.created_at });
        }
      }
    } else {
      for (const [i, b] of blocks.entries()) {
        if (
          b.type === 'tool_use' &&
          b.name === REPLY_TOOL_NAME &&
          Array.isArray(b.input?.bubbles)
        ) {
          for (const [j, bubble] of (b.input.bubbles as unknown[]).entries()) {
            if (typeof bubble === 'string' && bubble.trim()) {
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
  }
  return out;
}

export async function loadTranscript(conversationId: string): Promise<TranscriptItem[]> {
  const rows = await repo.listMessages(conversationId);
  return projectTranscript(rows);
}
