import 'server-only';
import * as repo from '@/lib/db/repo';
import { log } from '@/lib/log';
import { runProactiveTurn } from '@/lib/agent/loop';
import type { TripRules } from '@/lib/trip/rules';
import {
  checkFlightHealth,
  simulateFlightDisruption,
  simulateHotelCancellation,
} from '@/lib/agent/trip-health';
import { moveProcedure } from '@/lib/agent/procedure';

/**
 * What an operator can do to a trip.
 *
 * Each action is the outside world doing something to the patient: the airline
 * cancels or moves a flight, the hotel drops the room. None of them touch a booking
 * or reach Sabre to change anything — they write the same `trip_events` a real feed
 * would, and the chat reacts on its next turn exactly as it does for the CLI. The one
 * exception is `check`, which reads the live order back and records what it finds.
 *
 * The CLI's `ops <action> <conversationId>` runs the same list, so the two cannot
 * drift apart.
 */
export type OpsParams = Record<string, string>;

/** A field an action needs from the operator, rendered as an input beside its button. */
export interface OpsField {
  name: string;
  label: string;
  type: 'datetime-local';
}

interface OpsActionDef {
  label: string;
  fields?: readonly OpsField[];
  run: (id: string, params: OpsParams) => Promise<unknown>;
}

function required(params: OpsParams, name: string): string {
  const value = params[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const OPS_ACTIONS = {
  'cancel-outbound': {
    label: 'Airline cancels the outbound',
    run: (id: string) => simulateFlightDisruption(id, 'outbound', 'flight_cancelled'),
  },
  'cancel-return': {
    label: 'Airline cancels the return',
    run: (id: string) => simulateFlightDisruption(id, 'return', 'flight_cancelled'),
  },
  'delay-outbound': {
    label: 'Airline changes the outbound schedule',
    run: (id: string) => simulateFlightDisruption(id, 'outbound', 'flight_schedule_change'),
  },
  'delay-return': {
    label: 'Airline changes the return schedule',
    run: (id: string) => simulateFlightDisruption(id, 'return', 'flight_schedule_change'),
  },
  'hotel-cancelled': {
    label: 'Hotel cancels the reservation',
    run: (id: string) => simulateHotelCancellation(id),
  },
  'procedure-moved': {
    label: 'Clinic moves the procedure to',
    fields: [
      { name: 'procedureAtLocal', label: 'New date and time (local)', type: 'datetime-local' },
    ],
    run: async (id: string, params: OpsParams) => {
      const { move, event } = await moveProcedure(
        id,
        required(params, 'procedureAtLocal'),
        'simulated',
      );
      return { was: move.was, now: move.now, flight: move.flight, eventId: event?.id ?? null };
    },
  },
  check: {
    label: 'Re-read the flight from Sabre',
    run: (id: string) => checkFlightHealth(id),
  },
  ack: {
    label: 'Clear open events',
    run: async (id: string) => {
      const open = await repo.listOpenTripEvents(id);
      await repo.acknowledgeTripEvents(
        id,
        open.map((e) => e.id),
      );
      return { acknowledged: open.length };
    },
  },
} as const satisfies Record<string, OpsActionDef>;

export type OpsAction = keyof typeof OPS_ACTIONS;

export function isOpsAction(value: string): value is OpsAction {
  return value in OPS_ACTIONS;
}

/** The inputs an action asks the operator for, if any. */
export function opsFields(action: OpsAction): readonly OpsField[] {
  return (OPS_ACTIONS[action] as OpsActionDef).fields ?? [];
}

export async function runOpsAction(
  action: OpsAction,
  conversationId: string,
  params: OpsParams = {},
) {
  const result = await (OPS_ACTIONS[action] as OpsActionDef).run(conversationId, params);
  log.info({ conversationId, action, params }, 'operator action');
  return result;
}

/**
 * After an operator has done something to a trip, the agent tells the patient —
 * without waiting for them to type. Runs the same loop a patient message would, so
 * every guard applies, and is a no-op when there is nothing untold.
 */
export async function tellThePatient(conversationId: string): Promise<void> {
  const conversation = await repo.getConversation(conversationId);
  if (!conversation) return;
  try {
    const result = await runProactiveTurn(
      conversationId,
      conversation.trip_rules as unknown as TripRules,
    );
    if (result) {
      log.info({ conversationId, bubbles: result.bubbles.length }, 'patient told proactively');
    }
  } catch (e) {
    // The event is still open, so the agent raises it on the patient's next message
    // instead. Nothing is lost; it is just not instant.
    log.error(
      { conversationId, err: e instanceof Error ? e.message : String(e) },
      'proactive turn failed; will be raised on the next message',
    );
  }
}

/** What the console shows for each recent trip. */
export async function listTripsForOps(limit = 8) {
  const conversations = await repo.listRecentConversations(limit);
  return Promise.all(
    conversations.map(async (c) => {
      const [history, events] = await Promise.all([
        repo.listBookingHistory(c.id),
        repo.listOpenTripEvents(c.id),
      ]);
      const live = history.filter((b) => b.status === 'confirmed');
      const rules = c.trip_rules as { adults?: number; procedureAtLocal?: string };
      return {
        id: c.id,
        started: c.created_at,
        travellers: rules.adults ?? 1,
        procedureAtLocal: rules.procedureAtLocal ?? null,
        flight: live.find((b) => b.kind === 'flight') ?? null,
        hotel: live.find((b) => b.kind === 'hotel') ?? null,
        history: history.filter((b) => b.status !== 'confirmed'),
        openEvents: events,
      };
    }),
  );
}
