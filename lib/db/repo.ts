import 'server-only';
import { db } from './client';
import type {
  BookingKind,
  BookingRow,
  ConversationRow,
  Json,
  MessageRole,
  MessageRow,
  OfferKind,
  OfferRow,
  ToolCallRow,
  TripEventKind,
  TripEventRow,
  TripEventSource,
} from './types';

/**
 * Typed data access. One function per query; no business logic here.
 * Errors from PostgREST are thrown as plain Errors with the table + operation in the message.
 */
function fail(op: string, error: { message: string; code?: string }): never {
  throw new Error(`db.${op}: ${error.message}${error.code ? ` (${error.code})` : ''}`);
}

// ---- conversations ---------------------------------------------------------

export async function createConversation(
  tripRules: Json,
  visitorId: string,
): Promise<ConversationRow> {
  const { data, error } = await db()
    .from('conversations')
    .insert({ trip_rules: tripRules, visitor_id: visitorId })
    .select()
    .single();
  if (error) fail('createConversation', error);
  return data;
}

/** Trips created by this browser, newest first. */
export async function listConversationsForVisitor(
  visitorId: string,
  limit = 20,
): Promise<ConversationRow[]> {
  const { data, error } = await db()
    .from('conversations')
    .select()
    .eq('visitor_id', visitorId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail('listConversationsForVisitor', error);
  return data;
}

/**
 * Claims a conversation that has no owner yet, so trips started before trips
 * were listable (or before the visitor cookie existed) still appear in the list.
 */
export async function adoptConversation(id: string, visitorId: string): Promise<void> {
  const { error } = await db()
    .from('conversations')
    .update({ visitor_id: visitorId })
    .eq('id', id)
    .is('visitor_id', null);
  if (error) fail('adoptConversation', error);
}

/** Guards a switch: a visitor may only open a conversation it owns. */
export async function getConversationForVisitor(
  id: string,
  visitorId: string,
): Promise<ConversationRow | null> {
  const { data, error } = await db()
    .from('conversations')
    .select()
    .eq('id', id)
    .eq('visitor_id', visitorId)
    .maybeSingle();
  if (error) fail('getConversationForVisitor', error);
  return data;
}

export async function getConversation(id: string): Promise<ConversationRow | null> {
  const { data, error } = await db().from('conversations').select().eq('id', id).maybeSingle();
  if (error) fail('getConversation', error);
  return data;
}

/** Recent conversations, so a script can find a trip without a database client. */
export async function listRecentConversations(limit = 10): Promise<ConversationRow[]> {
  const { data, error } = await db()
    .from('conversations')
    .select()
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail('listRecentConversations', error);
  return data;
}

export async function touchConversation(id: string): Promise<void> {
  const { error } = await db().from('conversations').update({ status: 'open' }).eq('id', id);
  if (error) fail('touchConversation', error);
}

// ---- messages --------------------------------------------------------------

export async function appendMessage(
  conversationId: string,
  role: MessageRole,
  content: Json,
): Promise<MessageRow> {
  const { data, error } = await db()
    .from('messages')
    .insert({ conversation_id: conversationId, role, content })
    .select()
    .single();
  if (error) fail('appendMessage', error);
  return data;
}

export async function listMessages(conversationId: string): Promise<MessageRow[]> {
  const { data, error } = await db()
    .from('messages')
    .select()
    .eq('conversation_id', conversationId)
    .order('id', { ascending: true });
  if (error) fail('listMessages', error);
  return data;
}

// ---- offers ----------------------------------------------------------------

export interface NewOffer {
  kind: OfferKind;
  provider: string;
  providerOfferId: string;
  summary: Json;
  raw: Json;
  expiresAt: string | null;
}

export async function insertOffers(
  conversationId: string,
  offers: NewOffer[],
): Promise<OfferRow[]> {
  if (offers.length === 0) return [];
  const rows = offers.map((o) => ({
    conversation_id: conversationId,
    kind: o.kind,
    provider: o.provider,
    provider_offer_id: o.providerOfferId,
    summary: o.summary,
    raw: o.raw,
    expires_at: o.expiresAt,
  }));
  const { data, error } = await db().from('offers').insert(rows).select();
  if (error) fail('insertOffers', error);
  return data;
}

export async function getOffer(conversationId: string, offerId: string): Promise<OfferRow | null> {
  const { data, error } = await db()
    .from('offers')
    .select()
    .eq('id', offerId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) fail('getOffer', error);
  return data;
}

export async function listRecentOffers(
  conversationId: string,
  kind: OfferKind,
  limit = 10,
): Promise<OfferRow[]> {
  const { data, error } = await db()
    .from('offers')
    .select()
    .eq('conversation_id', conversationId)
    .eq('kind', kind)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail('listRecentOffers', error);
  return data;
}

// ---- bookings --------------------------------------------------------------

export interface NewBooking {
  kind: BookingKind;
  provider: string;
  providerOrderId: string;
  bookingReference: string;
  offerId: string | null;
  details: Json;
  raw: Json;
}

/** Inserts a confirmed booking. Throws with code 23505 if a live booking of this kind already exists. */
export async function insertBooking(conversationId: string, b: NewBooking): Promise<BookingRow> {
  const { data, error } = await db()
    .from('bookings')
    .insert({
      conversation_id: conversationId,
      kind: b.kind,
      provider: b.provider,
      provider_order_id: b.providerOrderId,
      booking_reference: b.bookingReference,
      offer_id: b.offerId,
      details: b.details,
      raw: b.raw,
    })
    .select()
    .single();
  if (error) fail('insertBooking', error);
  return data;
}

/** Bookings across several conversations, for labelling a trip list in one query. */
export async function listBookingsForConversations(
  conversationIds: string[],
): Promise<BookingRow[]> {
  if (conversationIds.length === 0) return [];
  const { data, error } = await db()
    .from('bookings')
    .select()
    .in('conversation_id', conversationIds)
    .eq('status', 'confirmed');
  if (error) fail('listBookingsForConversations', error);
  return data;
}

/**
 * Marks a booking cancelled. The reason is kept in the words the patient was given,
 * so an operator reading the row later sees the same explanation the patient did.
 */
export async function cancelBookingRow(id: string, reason: string): Promise<BookingRow> {
  const { data, error } = await db()
    .from('bookings')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), change_reason: reason })
    .eq('id', id)
    .eq('status', 'confirmed')
    .select()
    .single();
  if (error) fail('cancelBookingRow', error);
  return data;
}

/**
 * Links a rebooking to what it replaced. The old row becomes 'superseded' rather
 * than 'cancelled': the trip was not abandoned, it moved, and the chain is how that
 * history stays readable.
 */
export async function supersedeBookingRow(
  oldId: string,
  newId: string,
  reason: string,
): Promise<BookingRow> {
  const { data, error } = await db()
    .from('bookings')
    .update({
      status: 'superseded',
      replaced_by: newId,
      cancelled_at: new Date().toISOString(),
      change_reason: reason,
    })
    .eq('id', oldId)
    .eq('status', 'confirmed')
    .select()
    .single();
  if (error) fail('supersedeBookingRow', error);
  return data;
}

/** Every booking this conversation has ever held, newest first, live and historic. */
export async function listBookingHistory(conversationId: string): Promise<BookingRow[]> {
  const { data, error } = await db()
    .from('bookings')
    .select()
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false });
  if (error) fail('listBookingHistory', error);
  return data;
}

export async function listBookings(conversationId: string): Promise<BookingRow[]> {
  const { data, error } = await db()
    .from('bookings')
    .select()
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) fail('listBookings', error);
  return data;
}

export async function getLiveBooking(
  conversationId: string,
  kind: BookingKind,
): Promise<BookingRow | null> {
  const { data, error } = await db()
    .from('bookings')
    .select()
    .eq('conversation_id', conversationId)
    .eq('kind', kind)
    .eq('status', 'confirmed')
    .maybeSingle();
  if (error) fail('getLiveBooking', error);
  return data;
}

// ---- trip events -----------------------------------------------------------

export interface NewTripEvent {
  bookingId: string | null;
  kind: TripEventKind;
  detail: Json;
  source: TripEventSource;
}

export async function insertTripEvents(
  conversationId: string,
  events: NewTripEvent[],
): Promise<TripEventRow[]> {
  if (events.length === 0) return [];
  const { data, error } = await db()
    .from('trip_events')
    .insert(
      events.map((e) => ({
        conversation_id: conversationId,
        booking_id: e.bookingId,
        kind: e.kind,
        detail: e.detail,
        source: e.source,
      })),
    )
    .select();
  if (error) fail('insertTripEvents', error);
  return data;
}

/** What has happened that the patient has not been told about yet. */
export async function listOpenTripEvents(conversationId: string): Promise<TripEventRow[]> {
  const { data, error } = await db()
    .from('trip_events')
    .select()
    .eq('conversation_id', conversationId)
    .is('acknowledged_at', null)
    .order('created_at', { ascending: true });
  if (error) fail('listOpenTripEvents', error);
  return data;
}

/** Marks events as told-and-dealt-with, so they stop being raised every turn. */
export async function acknowledgeTripEvents(conversationId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db()
    .from('trip_events')
    .update({ acknowledged_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .in('id', ids);
  if (error) fail('acknowledgeTripEvents', error);
}

// ---- tool calls ------------------------------------------------------------

export interface NewToolCall {
  toolName: string;
  input: Json;
  output: Json | null;
  error: Json | null;
  providerRequests: Json | null;
  durationMs: number;
}

export async function recordToolCall(
  conversationId: string | null,
  t: NewToolCall,
): Promise<ToolCallRow> {
  const { data, error } = await db()
    .from('tool_calls')
    .insert({
      conversation_id: conversationId,
      tool_name: t.toolName,
      input: t.input,
      output: t.output,
      error: t.error,
      provider_requests: t.providerRequests,
      duration_ms: t.durationMs,
    })
    .select()
    .single();
  if (error) fail('recordToolCall', error);
  return data;
}

// ---- health ----------------------------------------------------------------

const TABLES = ['conversations', 'messages', 'offers', 'bookings', 'tool_calls'] as const;

export interface SchemaCheck {
  ok: boolean;
  present: string[];
  missing: { table: string; message: string }[];
}

/**
 * Verifies the migration has actually been applied.
 *
 * Uses a real GET select per table rather than a HEAD/count probe: PostgREST
 * answers a HEAD on a missing table without an error body, so supabase-js
 * surfaces no error and the check passes even though the table is not there.
 * Selecting a row is the only reliable signal.
 */
export async function checkSchema(): Promise<SchemaCheck> {
  const results = await Promise.all(
    TABLES.map(async (table) => {
      const { error } = await db().from(table).select('id').limit(1);
      return { table, message: error?.message };
    }),
  );
  const missing = results
    .filter((r) => r.message)
    .map((r) => ({ table: r.table, message: r.message as string }));
  return {
    ok: missing.length === 0,
    present: results.filter((r) => !r.message).map((r) => r.table),
    missing,
  };
}
