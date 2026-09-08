import { z } from 'zod';
import { log } from '@/lib/log';
import * as repo from '@/lib/db/repo';
import type { BookingKind, BookingRow } from '@/lib/db/types';
import { travelProvider } from '@/lib/providers/sabre';
import { isProviderError } from '@/lib/providers/sabre/errors';
import { defineTool } from './define';

/**
 * Cancels what the patient holds.
 *
 * Two things make this safe to hand a model:
 *
 * `confirmed` must be true, and the prompt allows it only after the patient has
 * said yes in the conversation — the same shape as booking. A patient asking "what
 * happens if I cancel?" must never lose their trip.
 *
 * The hotel goes first. It carries a deposit and a free-cancellation deadline, so
 * it is the leg where being slow costs money; the flight is refundable-by-void at
 * this stage. If one leg fails, the other is reported as still live by name, rather
 * than reporting a half-cancelled trip as cancelled.
 */
const CANCEL_ORDER: BookingKind[] = ['hotel', 'flight'];

interface Outcome {
  kind: BookingKind;
  reference: string;
  cancelled: boolean;
  detail?: string;
}

function terms(row: BookingRow): {
  refundable: boolean | null;
  cancelBy: string | null;
  totalUSD: number | null;
} {
  const details = (row.details ?? {}) as {
    refundable?: boolean;
    cancelBy?: string;
    totalUSD?: number;
    priceUSD?: number;
  };
  return {
    refundable: details.refundable ?? null,
    cancelBy: details.cancelBy ?? null,
    totalUSD: details.totalUSD ?? details.priceUSD ?? null,
  };
}

export const cancelTripTool = defineTool({
  name: 'cancel_trip',
  description:
    'Cancel bookings the patient holds. Only call this once the patient has clearly asked to cancel and confirmed it — never to answer a question about what cancelling would involve. Use get_trip_state first if you are unsure what is booked. Reports exactly what was cancelled and what, if anything, is still live.',
  schema: z.object({
    scope: z
      .enum(['both', 'flight', 'hotel'])
      .default('both')
      .describe('Cancel the whole trip, or only one leg if that is what they asked for.'),
    confirmed: z
      .literal(true)
      .describe('Only true after the patient has explicitly confirmed they want this cancelled.'),
    reason: z
      .string()
      .min(3)
      .max(200)
      .describe('Why, in the words you gave the patient — stored on the booking for the operator.'),
  }),
  handler: async (input, ctx) => {
    const wanted = input.scope === 'both' ? CANCEL_ORDER : [input.scope];
    const live = await Promise.all(
      wanted.map((kind) => repo.getLiveBooking(ctx.conversationId, kind)),
    );
    const rows = live.filter((r): r is BookingRow => r !== null);

    if (rows.length === 0) {
      return {
        cancelled: [],
        message:
          input.scope === 'both'
            ? 'There is nothing booked on this trip to cancel.'
            : `There is no ${input.scope} booked on this trip.`,
      };
    }

    const provider = travelProvider();
    const outcomes: Outcome[] = [];
    const stillLive: Outcome[] = [];

    // Sequential on purpose: if the hotel cannot be cancelled the patient needs to
    // hear that before the flight is touched.
    for (const row of rows) {
      try {
        const result = await provider.cancelBooking(row.booking_reference);
        if (result.cancelled) {
          await repo.cancelBookingRow(row.id, input.reason);
          outcomes.push({ kind: row.kind, reference: row.booking_reference, cancelled: true });
          log.info(
            { conversationId: ctx.conversationId, reference: row.booking_reference },
            'booking cancelled',
          );
        } else {
          stillLive.push({
            kind: row.kind,
            reference: row.booking_reference,
            cancelled: false,
            detail: `still holds ${result.remaining.join(' and ')}`,
          });
        }
      } catch (e) {
        const detail = isProviderError(e) ? e.message : e instanceof Error ? e.message : String(e);
        log.error(
          { conversationId: ctx.conversationId, reference: row.booking_reference, detail },
          'cancel failed',
        );
        stillLive.push({
          kind: row.kind,
          reference: row.booking_reference,
          cancelled: false,
          detail,
        });
      }
    }

    return {
      cancelled: outcomes.map((o) => ({ kind: o.kind, reference: o.reference })),
      stillLive: stillLive.map((o) => ({ kind: o.kind, reference: o.reference, why: o.detail })),
      // What the patient may be charged, from the terms recorded when it was booked.
      terms: rows.map((row) => ({
        kind: row.kind,
        reference: row.booking_reference,
        ...terms(row),
      })),
      message:
        stillLive.length === 0
          ? 'Cancelled with the provider and verified.'
          : 'Part of the trip could not be cancelled. Tell the patient exactly which booking is still live and that you will keep working on it — do not describe the trip as cancelled.',
    };
  },
});
