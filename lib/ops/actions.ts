import 'server-only';
import * as repo from '@/lib/db/repo';
import { log } from '@/lib/log';
import {
  checkFlightHealth,
  simulateFlightDisruption,
  simulateHotelCancellation,
} from '@/lib/agent/trip-health';

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
} as const;

export type OpsAction = keyof typeof OPS_ACTIONS;

export function isOpsAction(value: string): value is OpsAction {
  return value in OPS_ACTIONS;
}

export async function runOpsAction(action: OpsAction, conversationId: string) {
  const result = await OPS_ACTIONS[action].run(conversationId);
  log.info({ conversationId, action }, 'operator action');
  return result;
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
      return {
        id: c.id,
        started: c.created_at,
        travellers: (c.trip_rules as { adults?: number }).adults ?? 1,
        flight: live.find((b) => b.kind === 'flight') ?? null,
        hotel: live.find((b) => b.kind === 'hotel') ?? null,
        history: history.filter((b) => b.status !== 'confirmed'),
        openEvents: events,
      };
    }),
  );
}
