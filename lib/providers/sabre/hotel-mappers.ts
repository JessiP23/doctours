import type { HotelRate, Money } from '@/lib/providers/types';
import { nightsBetween } from '@/lib/trip/nights';

/**
 * Sabre Get Hotel Details (POST /v5/get/hoteldetails) → normalized room rates.
 *
 * Shape:
 *   HotelDetailsInfo.HotelRateInfo.RoomSets.RoomSet[]   grouped by room + bed type
 *     .Room[]                                            a bookable room
 *       .RatePlans.RatePlan[]                            a price for that room
 *         .RateKey        → Hotel Price Check turns this into a BookingKey
 *         .ProductCode    → required when creating the booking
 *         .ConvertedRateInfo → totals, taxes, cancellation terms
 *
 * One (Room, RatePlan) pair is one bookable option, which is what "cheapest
 * available room" ranks over.
 */

/** Sabre returns a single object where an array is expected often enough to matter. */
function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function money(amount: string | undefined, currency: string | undefined): Money | null {
  if (!amount || !currency) return null;
  const value = Number(amount);
  return Number.isFinite(value) ? { amount: value, currency } : null;
}

interface SabreRateInfo {
  StartDate?: string;
  EndDate?: string;
  AmountBeforeTax?: string;
  AmountAfterTax?: string;
  AverageNightlyRate?: string;
  ApproxTotalPrice?: string;
  CurrencyCode?: string;
  Taxes?: { Amount?: string; CurrencyCode?: string };
  CancelPenalties?: {
    CancelPenalty?:
      | { Refundable?: boolean; Deadline?: { AbsoluteDeadline?: string } }
      | { Refundable?: boolean; Deadline?: { AbsoluteDeadline?: string } }[];
  };
}

interface SabreRatePlan {
  RatePlanName?: string;
  RatePlanCode?: string;
  ProductCode?: string;
  RateKey?: string;
  PrepaidIndicator?: boolean;
  AvailableQuantity?: number;
  MealsIncluded?: { MealPlanDescription?: string };
  RatePlanDescription?: { Text?: string[] };
  ConvertedRateInfo?: SabreRateInfo;
}

interface SabreRoom {
  RoomIndex?: number;
  RoomType?: string;
  RoomID?: string;
  NonSmoking?: boolean;
  Occupancy?: { Max?: number };
  RoomDescription?: { Name?: string; Text?: string[] };
  BedTypeOptions?: { BedTypes?: { BedType?: { Description?: string }[] }[] };
  RatePlans?: { RatePlan?: SabreRatePlan | SabreRatePlan[] };
}

interface SabreRoomSet {
  RoomSetAttributes?: { RoomSetAttribute?: { Type?: string; Value?: string }[] };
  Room?: SabreRoom | SabreRoom[];
}

export interface HotelDetailsResponse {
  GetHotelDetailsRS?: {
    HotelDetailsInfo?: {
      HotelInfo?: { HotelCode?: string; HotelName?: string };
      HotelRateInfo?: { RoomSets?: { RoomSet?: SabreRoomSet | SabreRoomSet[] } };
    };
  };
}

function bedTypesOf(room: SabreRoom, setAttributes: { Type?: string; Value?: string }[]): string[] {
  const fromRoom = toArray(room.BedTypeOptions?.BedTypes)
    .flatMap((b) => toArray(b.BedType))
    .map((b) => b.Description)
    .filter((d): d is string => Boolean(d));
  if (fromRoom.length > 0) return [...new Set(fromRoom)];
  return setAttributes.filter((a) => a.Type === 'BedType' && a.Value).map((a) => a.Value as string);
}

function cancellationOf(rate: SabreRateInfo | undefined) {
  const penalty = toArray(rate?.CancelPenalties?.CancelPenalty)[0];
  return {
    refundable: penalty?.Refundable ?? null,
    cancelBy: penalty?.Deadline?.AbsoluteDeadline ?? null,
  };
}

export interface HotelMapResult {
  rates: HotelRate[];
  skipped: { room: string; reason: string }[];
}

/**
 * Maps Get Hotel Details into bookable room rates.
 *
 * Fails soft per rate plan: an entry without a RateKey or a readable price is
 * skipped with a reason, because a rate we cannot price is a rate we must not offer.
 */
export function mapHotelDetailsResponse(
  response: HotelDetailsResponse,
  fallback: { checkIn: string; checkOut: string; propertyId: string },
  provider = 'sabre',
): HotelMapResult {
  const info = response.GetHotelDetailsRS?.HotelDetailsInfo;
  const propertyId = info?.HotelInfo?.HotelCode ?? fallback.propertyId;
  const propertyName = info?.HotelInfo?.HotelName ?? 'the hotel';

  const rates: HotelRate[] = [];
  const skipped: { room: string; reason: string }[] = [];

  for (const set of toArray(info?.HotelRateInfo?.RoomSets?.RoomSet)) {
    const attributes = set.RoomSetAttributes?.RoomSetAttribute ?? [];
    for (const room of toArray(set.Room)) {
      const roomName = room.RoomDescription?.Name ?? room.RoomType ?? 'Room';
      for (const plan of toArray(room.RatePlans?.RatePlan)) {
        const label = `${room.RoomType ?? 'Room'} / ${plan.RatePlanName ?? plan.RatePlanCode ?? 'rate'}`;
        try {
          if (!plan.RateKey) throw new Error('rate plan has no RateKey');
          const rate = plan.ConvertedRateInfo;
          const checkIn = rate?.StartDate ?? fallback.checkIn;
          const checkOut = rate?.EndDate ?? fallback.checkOut;
          const currency = rate?.CurrencyCode;
          const total = money(rate?.AmountAfterTax ?? rate?.ApproxTotalPrice, currency);
          if (!total) throw new Error('rate plan has no readable total');
          const nights = nightsBetween(checkIn, checkOut);
          const nightly =
            money(rate?.AverageNightlyRate, currency) ??
            ({
              amount: Number((total.amount / Math.max(nights, 1)).toFixed(2)),
              currency: total.currency,
            } as Money);
          const { refundable, cancelBy } = cancellationOf(rate);

          rates.push({
            id: plan.RateKey,
            provider,
            propertyId,
            propertyName,
            roomName: room.RoomType ?? roomName,
            roomDescription:
              room.RoomDescription?.Text?.[0] ?? plan.RatePlanDescription?.Text?.[0] ?? null,
            bedTypes: bedTypesOf(room, attributes),
            maxOccupancy: room.Occupancy?.Max ?? null,
            productCode: plan.ProductCode ?? null,
            ratePlanName: plan.RatePlanName ?? null,
            checkIn,
            checkOut,
            nights,
            nightly,
            total,
            taxes: money(rate?.Taxes?.Amount, rate?.Taxes?.CurrencyCode ?? currency),
            refundable,
            cancelBy,
            mealPlan: plan.MealsIncluded?.MealPlanDescription ?? null,
            prepaid: plan.PrepaidIndicator ?? null,
            availableQuantity: plan.AvailableQuantity ?? null,
            // Hotel rates carry no explicit validity window; Price Check is what
            // re-confirms the price at booking time.
            expiresAt: null,
            raw: { room, plan },
          });
        } catch (e) {
          skipped.push({ room: label, reason: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }

  return { rates, skipped };
}

/** Cheapest first by total paid, then by nightly rate as a tie-break. */
export function cheapestFirst(rates: HotelRate[]): HotelRate[] {
  return [...rates].sort(
    (a, b) => a.total.amount - b.total.amount || a.nightly.amount - b.nightly.amount,
  );
}
