/**
 * Hand-maintained database types mirroring supabase/migrations.
 * Keep in sync when a migration changes a table (or regenerate with `supabase gen types`).
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type ConversationStatus = 'open' | 'completed' | 'cancelled';
export type MessageRole = 'user' | 'assistant';
export type OfferKind = 'flight' | 'hotel_rate';
export type BookingKind = 'flight' | 'hotel';
/**
 * A booking is confirmed until it is either cancelled outright or superseded by a
 * rebooking. There is no 'paid' or 'pending' — see docs/DECISIONS.md.
 */
export type BookingStatus = 'confirmed' | 'cancelled' | 'superseded';

export type ConversationRow = {
  id: string;
  created_at: string;
  updated_at: string;
  trip_rules: Json;
  status: ConversationStatus;
  /** Opaque per-browser owner. Null for rows created before trips were listable. */
  visitor_id: string | null;
};

export type MessageRow = {
  id: number;
  conversation_id: string;
  role: MessageRole;
  content: Json;
  created_at: string;
};

export type OfferRow = {
  id: string;
  conversation_id: string;
  kind: OfferKind;
  provider: string;
  provider_offer_id: string;
  summary: Json;
  raw: Json;
  expires_at: string | null;
  created_at: string;
};

export type BookingRow = {
  id: string;
  conversation_id: string;
  kind: BookingKind;
  provider: string;
  provider_order_id: string;
  booking_reference: string;
  status: BookingStatus;
  /** The booking that took this one's place, when the trip was rebooked. */
  replaced_by: string | null;
  cancelled_at: string | null;
  /** Why it was cancelled or superseded, in the words the patient was given. */
  change_reason: string | null;
  offer_id: string | null;
  details: Json;
  raw: Json;
  created_at: string;
  updated_at: string;
};

export type ToolCallRow = {
  id: number;
  conversation_id: string | null;
  tool_name: string;
  input: Json;
  output: Json | null;
  error: Json | null;
  provider_requests: Json | null;
  duration_ms: number | null;
  created_at: string;
};

type Table<Row, Insert, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export interface Database {
  public: {
    Tables: {
      conversations: Table<
        ConversationRow,
        Pick<ConversationRow, 'trip_rules'> &
          Partial<Pick<ConversationRow, 'id' | 'status' | 'visitor_id'>>
      >;
      messages: Table<MessageRow, Pick<MessageRow, 'conversation_id' | 'role' | 'content'>>;
      offers: Table<OfferRow, Omit<OfferRow, 'id' | 'created_at'> & Partial<Pick<OfferRow, 'id'>>>;
      bookings: Table<
        BookingRow,
        Omit<
          BookingRow,
          | 'id'
          | 'created_at'
          | 'updated_at'
          | 'status'
          | 'replaced_by'
          | 'cancelled_at'
          | 'change_reason'
        > &
          Partial<
            Pick<BookingRow, 'id' | 'status' | 'replaced_by' | 'cancelled_at' | 'change_reason'>
          >
      >;
      tool_calls: Table<ToolCallRow, Omit<ToolCallRow, 'id' | 'created_at'>>;
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}
