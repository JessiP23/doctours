/**
 * Sabre CERT smoke script — run BEFORE building the agent, and whenever the API surprises you.
 *
 *   npm run sabre:smoke -- auth
 *   npm run sabre:smoke -- flights [departDate] [returnDate]     shop JFK→IST round trip, save fixture
 *   npm run sabre:smoke -- hotels-geo [checkIn] [checkOut]       hotels around IST, save fixture
 *   npm run sabre:smoke -- hotel <hotelCode> [checkIn] [checkOut] one property's rates, save fixture
 *   npm run sabre:smoke -- pricecheck <rateKey>                  price check a RateKey → BookingKey
 *   npm run sabre:smoke -- hotels-beta [checkIn] [checkOut]      agentic-ready /v1/hotels/hotelSearch around IST
 *   npm run sabre:smoke -- hotels-probe [checkIn] [checkOut]     try every strategy, report which returns rates
 *   npm run sabre:smoke -- e2e [--dry-run]                       the whole booking path, no model: shop → check →
 *                                                                book flight, then rooms → price check → book hotel;
 *                                                                records references in docs/BOOKINGS.md
 *   npm run sabre:smoke -- lookup <reference>                    Get Booking: prove a reference is a real order
 *   npm run sabre:smoke -- cancel <reference>                    cancel an order and verify it is gone
 *
 * Raw responses are written to tests/fixtures/sabre/<name>.json so mappers can be
 * written and unit-tested against real payloads.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { getEnv, paymentCard } from '@/lib/env';
import { SabreProvider, retrieveBooking, unconfirmedFlightsOf } from '@/lib/providers/sabre';
import { excludeRefused, isCodeshare, type RefusedFlight } from '@/lib/trip/select';
import { partitionOffers } from '@/lib/trip/validate';
import { deriveStay } from '@/lib/trip/nights';
import { getAccessToken, tokenExpiresAt } from '@/lib/providers/sabre/auth';
import { sabreFetch } from '@/lib/providers/sabre/http';
import {
  buildFlightShopRequest,
  buildHotelAvailRequest,
  buildHotelDetailsRequest,
  buildHotelPriceCheckRequest,
  buildHotelSearchBetaRequest,
} from '@/lib/providers/sabre/requests';
import { withProviderTrace } from '@/lib/providers/trace';
import { TRIP_RULES } from '@/lib/trip/rules';

const [cmd = 'auth', ...args] = process.argv.slice(2);
const FIXTURES = path.resolve(process.cwd(), 'tests/fixtures/sabre');

/**
 * Persists a captured payload, with account identifiers replaced by placeholders.
 *
 * Fixtures are committed so the mapper tests run without network access, and this
 * repository is read by other people — the PCC and user id must not travel with them.
 */
function redact(data: unknown): unknown {
  const env = (() => {
    try {
      return getEnv();
    } catch {
      return null;
    }
  })();
  if (!env) return data;
  let json = JSON.stringify(data);
  for (const [placeholder, secret] of [
    ['REDACTED_PCC', env.SABRE_PCC],
    ['REDACTED_USER_ID', env.SABRE_USER_ID],
  ] as const) {
    if (secret) json = json.split(secret).join(placeholder);
  }
  return JSON.parse(json);
}

async function saveFixture(name: string, data: unknown) {
  await mkdir(FIXTURES, { recursive: true });
  const file = path.join(FIXTURES, `${name}.json`);
  await writeFile(file, JSON.stringify(redact(data), null, 2));
  return file;
}

function summarize(obj: unknown, depth = 0): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj))
    return `Array(${obj.length})${obj.length && depth < 3 ? ` of ${summarize(obj[0], depth + 1)}` : ''}`;
  if (depth >= 3) return '{…}';
  const entries = Object.entries(obj as Record<string, unknown>).map(
    ([k, v]) => `${k}: ${summarize(v, depth + 1)}`,
  );
  return `{ ${entries.join(', ')} }`;
}

async function auth() {
  const { result, requests } = await withProviderTrace(() => getAccessToken());
  console.log(
    JSON.stringify(
      { ok: true, tokenPreview: `${result.slice(0, 12)}…`, expiresAt: tokenExpiresAt(), requests },
      null,
      2,
    ),
  );
}

async function flights() {
  const [
    departDate = TRIP_RULES.outboundDepartureDates[0],
    returnDate = TRIP_RULES.returnDepartureDates[0],
  ] = args;
  const body = buildFlightShopRequest({
    origin: TRIP_RULES.origin,
    destination: TRIP_RULES.destination,
    departDate,
    returnDate,
    adults: TRIP_RULES.adults,
    cabin: TRIP_RULES.cabin,
    currency: TRIP_RULES.currency,
  });
  const { result, requests } = await withProviderTrace(() =>
    sabreFetch<Record<string, unknown>>({
      method: 'POST',
      path: '/v1/offers/flightShop',
      body,
      timeoutMs: 60_000,
    }),
  );
  const file = await saveFixture(`flight-shop-${departDate}-${returnDate}`, {
    request: body,
    response: result,
  });
  console.log(JSON.stringify({ ok: true, file, requests, shape: summarize(result) }, null, 2));
}

async function hotelsGeo() {
  const env = getEnv();
  const [checkIn = '2026-10-12', checkOut = '2026-10-17'] = args;
  const body = buildHotelAvailRequest(
    env.SABRE_PCC,
    { checkIn, checkOut, adults: 1, currency: 'USD' },
    { refPointCode: TRIP_RULES.destination, radiusMiles: 20, pageSize: 20 },
  );
  const { result, requests } = await withProviderTrace(() =>
    sabreFetch<Record<string, unknown>>({
      method: 'POST',
      path: '/v5/get/hotelavail',
      body,
      timeoutMs: 60_000,
    }),
  );
  const file = await saveFixture(
    `hotel-avail-geo-${TRIP_RULES.destination}-${checkIn}-${checkOut}`,
    { request: body, response: result },
  );
  console.log(JSON.stringify({ ok: true, file, requests, shape: summarize(result) }, null, 2));
}

async function hotel() {
  const env = getEnv();
  const [hotelCode, checkIn = '2026-10-12', checkOut = '2026-10-17'] = args;
  if (!hotelCode) throw new Error('usage: hotel <hotelCode> [checkIn] [checkOut]');
  const stay = { checkIn, checkOut, adults: 1, currency: 'USD' };
  const avail = await withProviderTrace(() =>
    sabreFetch<Record<string, unknown>>({
      method: 'POST',
      path: '/v5/get/hotelavail',
      body: buildHotelAvailRequest(env.SABRE_PCC, stay, { hotelCodes: [hotelCode] }),
      timeoutMs: 60_000,
    }),
  );
  const details = await withProviderTrace(() =>
    sabreFetch<Record<string, unknown>>({
      method: 'POST',
      path: '/v5/get/hoteldetails',
      body: buildHotelDetailsRequest(env.SABRE_PCC, hotelCode, stay),
      timeoutMs: 60_000,
    }),
  );
  const f1 = await saveFixture(`hotel-avail-${hotelCode}-${checkIn}-${checkOut}`, {
    response: avail.result,
  });
  const f2 = await saveFixture(`hotel-details-${hotelCode}-${checkIn}-${checkOut}`, {
    response: details.result,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        files: [f1, f2],
        requests: [...avail.requests, ...details.requests],
        availShape: summarize(avail.result),
        detailsShape: summarize(details.result),
      },
      null,
      2,
    ),
  );
}

async function hotelsBeta() {
  const [checkIn = '2026-10-12', checkOut = '2026-10-17'] = args;
  const body = buildHotelSearchBetaRequest(
    { checkIn, checkOut, adults: 1 },
    { airportCode: TRIP_RULES.destination, radiusMiles: 20 },
  );
  const { result, requests } = await withProviderTrace(() =>
    sabreFetch<Record<string, unknown>>({
      method: 'POST',
      path: '/v1/hotels/hotelSearch',
      body,
      timeoutMs: 60_000,
    }),
  );
  const file = await saveFixture(
    `hotel-search-beta-${TRIP_RULES.destination}-${checkIn}-${checkOut}`,
    { request: body, response: result },
  );
  console.log(JSON.stringify({ ok: true, file, requests, shape: summarize(result) }, null, 2));
}

/**
 * CERT hotel inventory is sparse and differs by endpoint, rate source and search
 * shape. Rather than guessing, try every strategy once and report which returns
 * bookable rates — that decides which property gets pinned in TRIP_RULES.
 */
async function hotelsProbe() {
  const env = getEnv();
  const [checkIn = '2026-10-12', checkOut = '2026-10-17'] = args;
  const stay = { checkIn, checkOut, adults: 1, currency: 'USD' };

  // Property codes Sabre's own CERT examples use — known to hold test inventory.
  const CERT_PROPERTIES = [
    '100000238',
    '100000126',
    '100000210',
    '100000230',
    '100000254',
    '100000270',
    '100000048',
  ];

  const attempts: { name: string; path: string; body: unknown }[] = [
    {
      name: 'beta hotelSearch @ IST 20mi',
      path: '/v1/hotels/hotelSearch',
      body: buildHotelSearchBetaRequest(stay, {
        airportCode: TRIP_RULES.destination,
        radiusMiles: 20,
      }),
    },
    {
      name: 'beta hotelSearch @ IST 60mi',
      path: '/v1/hotels/hotelSearch',
      body: buildHotelSearchBetaRequest(stay, {
        airportCode: TRIP_RULES.destination,
        radiusMiles: 60,
      }),
    },
    {
      name: 'beta hotelSearch @ Istanbul lat/long 20mi',
      path: '/v1/hotels/hotelSearch',
      body: {
        radiusInMiles: 20,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        numberOfAdults: 1,
        latitude: 41.0082,
        longitude: 28.9784,
      },
    },
    {
      name: 'v5 avail geo IST 30mi source 100,113',
      path: '/v5/get/hotelavail',
      body: buildHotelAvailRequest(
        env.SABRE_PCC,
        stay,
        { refPointCode: TRIP_RULES.destination, radiusMiles: 30, pageSize: 40 },
        { rateSource: '100,113' },
      ),
    },
    {
      name: 'v5 avail city IST 30mi source 100,113',
      path: '/v5/get/hotelavail',
      body: buildHotelAvailRequest(
        env.SABRE_PCC,
        stay,
        { refPointCode: TRIP_RULES.destination, radiusMiles: 30, pageSize: 40, refPointType: '16' },
        { rateSource: '100,113' },
      ),
    },
    {
      name: 'v5 avail known CERT property codes',
      path: '/v5/get/hotelavail',
      body: buildHotelAvailRequest(
        env.SABRE_PCC,
        stay,
        { hotelCodes: CERT_PROPERTIES },
        { rateSource: '100,113' },
      ),
    },
    {
      name: 'v5 avail geo DFW 30mi (control: does hotel content work at all?)',
      path: '/v5/get/hotelavail',
      body: buildHotelAvailRequest(
        env.SABRE_PCC,
        stay,
        { refPointCode: 'DFW', radiusMiles: 30, pageSize: 40 },
        { rateSource: '100,113' },
      ),
    },
  ];

  const summary: { name: string; status: string; properties: number; note?: string }[] = [];

  for (const [i, attempt] of attempts.entries()) {
    try {
      const { result } = await withProviderTrace(() =>
        sabreFetch<Record<string, unknown>>({
          method: 'POST',
          path: attempt.path,
          body: attempt.body,
          timeoutMs: 60_000,
        }),
      );
      await saveFixture(`probe-${i + 1}`, {
        name: attempt.name,
        path: attempt.path,
        request: attempt.body,
        response: result,
      });
      summary.push({
        name: attempt.name,
        status: 'ok',
        properties: countProperties(result),
        note: warningOf(result),
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      await saveFixture(`probe-${i + 1}-error`, {
        name: attempt.name,
        path: attempt.path,
        request: attempt.body,
        error: err,
      });
      summary.push({
        name: attempt.name,
        status: err.code ?? 'error',
        properties: 0,
        note: err.message,
      });
    }
  }

  console.log(JSON.stringify({ ok: true, checkIn, checkOut, summary }, null, 2));
}

/** Reads a nested path without assuming the response shape. */
function at(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || typeof node !== 'object') return undefined;
    const index = Number(key);
    if (Number.isInteger(index) && Array.isArray(node)) return node[index];
    return (node as Record<string, unknown>)[key];
  }, source);
}

/** Counts properties in either response shape without assuming which one came back. */
function countProperties(result: unknown): number {
  const v5 = at(result, 'GetHotelAvailRS.HotelAvailInfos.HotelAvailInfo');
  if (Array.isArray(v5)) return v5.length;
  for (const key of ['hotels', 'Hotels', 'hotelResults', 'results', 'data']) {
    const list = at(result, key);
    if (Array.isArray(list)) return list.length;
  }
  return 0;
}

function warningOf(result: unknown): string | undefined {
  const message = at(
    result,
    'GetHotelAvailRS.ApplicationResults.Warning.0.SystemSpecificResults.0.Message',
  );
  if (!Array.isArray(message)) return undefined;
  return message
    .map((m) => (at(m, 'value') as string) ?? '')
    .filter(Boolean)
    .join(' | ');
}

async function pricecheck() {
  const env = getEnv();
  const [rateKey] = args;
  if (!rateKey) throw new Error('usage: pricecheck <rateKey>');
  const { result, requests } = await withProviderTrace(() =>
    sabreFetch<Record<string, unknown>>({
      method: 'POST',
      path: '/v5/hotel/pricecheck',
      body: buildHotelPriceCheckRequest(env.SABRE_PCC, rateKey),
      timeoutMs: 60_000,
    }),
  );
  const file = await saveFixture('hotel-pricecheck', { response: result });
  console.log(JSON.stringify({ ok: true, file, requests, shape: summarize(result) }, null, 2));
}

/**
 * End-to-end booking path with the real provider and the real rules, without the
 * model. This is the deterministic proof that the integration works; the chat
 * adds conversation on top of exactly these calls.
 *
 * Bookings made here are real CERT orders and are recorded in docs/BOOKINGS.md.
 * --dry-run stops before creating anything.
 */
async function e2e() {
  const dryRun = args.includes('--dry-run');
  const provider = new SabreProvider();
  const env = getEnv();
  const started = new Date();
  const guest = {
    givenName: 'Doctours',
    familyName: 'Testpatient',
    dateOfBirth: '1985-01-01',
    gender: 'M' as const,
    email: 'travel@doctours.test',
    phone: '+16463875453',
  };
  const step = (name: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ step: name, at: new Date().toISOString(), ...extra }));

  // 1. Shop every allowed date pairing, apply the trip rules, take the cheapest.
  const searches = TRIP_RULES.outboundDepartureDates.flatMap((departDate) =>
    TRIP_RULES.returnDepartureDates.map((returnDate) => ({ departDate, returnDate })),
  );
  const shopped = await Promise.allSettled(
    searches.map((s) =>
      provider.searchFlights({
        origin: TRIP_RULES.origin,
        destination: TRIP_RULES.destination,
        departDate: s.departDate,
        returnDate: s.returnDate,
        adults: TRIP_RULES.adults,
        cabin: TRIP_RULES.cabin,
        currency: TRIP_RULES.currency,
      }),
    ),
  );
  const found = shopped.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const { valid, rejected } = partitionOffers(found, TRIP_RULES);
  step('flights shopped', { found: found.length, valid: valid.length, rejected: rejected.length });
  if (valid.length === 0) throw new Error('No flight satisfies the trip rules');

  // Cheapest first, one entry per distinct itinerary. Flight Shop is cache-based and
  // Create Booking is live, so an airline can refuse the cached class ("UC"). When it
  // does, the flights it refused — and other codeshares marketed by that carrier —
  // are dropped from the remaining candidates, as the agent does for a patient.
  const distinct = (offers: typeof valid) => {
    const seen = new Set<string>();
    return offers
      .sort((a, b) => a.price.amount - b.price.amount)
      .filter((o) => {
        const key = o.slices
          .flatMap((sl) => sl.segments.map((g) => `${g.carrier}${g.flightNumber}@${g.departLocal}`))
          .join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };
  const MAX_ATTEMPTS = 5;
  let remaining = distinct([...valid]);
  const refused: RefusedFlight[] = [];

  let chosen = remaining[0];
  let priced = chosen;
  let stay = deriveStay(chosen.slices[0], chosen.slices[1]);
  let flight: Awaited<ReturnType<typeof provider.createFlightOrder>> | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && remaining.length > 0; attempt++) {
    const candidate = remaining[0];
    chosen = candidate;
    stay = deriveStay(candidate.slices[0], candidate.slices[1]);
    step(`candidate ${attempt}`, {
      priceUSD: candidate.price.amount,
      outbound: `${candidate.slices[0].segments[0].departLocal} → ${candidate.slices[0].segments.at(-1)!.arriveLocal}`,
      inbound: `${candidate.slices[1].segments[0].departLocal} → ${candidate.slices[1].segments.at(-1)!.arriveLocal}`,
      stops: candidate.slices.map((sl) => sl.stops),
      classes: candidate.slices.flatMap((sl) =>
        sl.segments.map((g) => `${g.carrier}${g.flightNumber}:${g.bookingClass}`),
      ),
      codeshare: isCodeshare(candidate),
      stay,
      remainingCandidates: remaining.length,
    });

    // 2. Flight Check re-prices it live. Keep the raw response as a fixture.
    const check = await provider.flightCheck(candidate);
    await saveFixture(`e2e-flightcheck-${attempt}`, { response: check.raw });
    if (!check.offer) {
      step('flight check found nothing', { attempt });
      remaining = remaining.slice(1);
      continue;
    }
    priced =
      check.offer.slices.length > 0 ? check.offer : { ...check.offer, slices: candidate.slices };
    step('flight check ok', {
      priceUSD: priced.price.amount,
      changed: priced.price.amount !== candidate.price.amount,
      classes: priced.slices.flatMap((sl) =>
        sl.segments.map((g) => `${g.carrier}${g.flightNumber}:${g.bookingClass}`),
      ),
    });

    if (dryRun) break;

    // 4a. Book the flight. A refusal removes those flights and that carrier's codeshares.
    try {
      flight = await provider.createFlightOrder(priced, [guest]);
      step('FLIGHT BOOKED', {
        bookingReference: flight.bookingReference,
        orderId: flight.id,
        attempt,
      });
      break;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === 'NO_AVAILABILITY') {
        const newlyRefused = unconfirmedFlightsOf(e);
        refused.push(...newlyRefused);
        const before = remaining.length;
        remaining = excludeRefused(remaining.slice(1), refused);
        step('airline could not confirm, excluding what it refused', {
          attempt,
          refused: newlyRefused.map((r) => `${r.carrier}${r.flightNumber}`),
          candidatesDropped: before - 1 - remaining.length,
          candidatesLeft: remaining.length,
        });
        continue;
      }
      throw e;
    }
  }

  // 3. Rooms for the derived nights, cheapest first.
  const rates = await provider.searchHotelRates({
    propertyId: TRIP_RULES.hotel.providerPropertyId,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    adults: TRIP_RULES.adults,
    currency: TRIP_RULES.currency,
  });
  const room = rates[0];
  step('rooms found', {
    hotel: room.propertyName,
    rates: rates.length,
    cheapest: {
      room: room.roomName,
      plan: room.ratePlanName,
      totalUSD: room.total.amount,
      refundable: room.refundable,
    },
    cardConfigured: Boolean(paymentCard(env)),
  });

  if (dryRun) {
    step('dry run complete — nothing booked');
    return;
  }
  if (!flight)
    throw new Error(
      `No candidate itinerary could be booked (${MAX_ATTEMPTS} attempts; refused: ${refused.map((r) => r.carrier + r.flightNumber).join(', ')})`,
    );

  // 4b. Book the hotel. References come only from Sabre's responses.
  const hotel = await provider.createHotelBooking(room, guest);
  step('HOTEL BOOKED', {
    bookingReference: hotel.bookingReference,
    orderId: hotel.id,
    totalUSD: hotel.total.amount,
  });

  // 5. Prove both exist by reading them back.
  const [flightLookup, hotelLookup] = await Promise.all([
    retrieveBooking(flight.bookingReference),
    retrieveBooking(hotel.bookingReference),
  ]);
  const summarizeLookup = (r: { raw: unknown }) => {
    const b = r.raw as {
      bookingId?: string;
      flights?: unknown[];
      hotels?: unknown[];
      travelers?: unknown[];
    };
    return {
      bookingId: b.bookingId,
      flights: b.flights?.length ?? 0,
      hotels: b.hotels?.length ?? 0,
      travelers: b.travelers?.length ?? 0,
    };
  };
  step('verified with Get Booking', {
    flight: summarizeLookup(flightLookup),
    hotel: summarizeLookup(hotelLookup),
  });
  await saveFixture(`e2e-getbooking-${flight.bookingReference}`, {
    flight: flightLookup.raw,
    hotel: hotelLookup.raw,
  });

  // 6. Record the run.
  const date = started.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const rows = [
    `| ${date} | flight | ${flight.bookingReference} | ${flight.id} | scripts/sabre-smoke.ts e2e | $${priced.price.amount} ${chosen.slices[0].segments[0].carrier}, ${stay.nights} nights derived |`,
    `| ${date} | hotel | ${hotel.bookingReference} | ${hotel.id} | scripts/sabre-smoke.ts e2e | ${room.propertyName}, ${room.roomName}, $${hotel.total.amount} |`,
  ];
  await appendFile(path.resolve(process.cwd(), 'docs/BOOKINGS.md'), rows.join('\n') + '\n');
  step('recorded in docs/BOOKINGS.md', { rows: rows.length });
}

/**
 * Reads an order back from Sabre and prints what actually matters: whether the
 * segments are confirmed, the dates held, and the hotel's own vendor
 * confirmation. This is how a reference quoted in the chat is verified.
 */
async function lookup() {
  const [reference] = args;
  if (!reference) throw new Error('usage: lookup <reference>');
  const { result, requests } = await withProviderTrace(() => retrieveBooking(reference));
  const b = result.raw as {
    bookingId?: string;
    startDate?: string;
    endDate?: string;
    isCancelable?: boolean;
    isTicketed?: boolean;
    travelers?: { givenName?: string; surname?: string }[];
    flights?: {
      airlineCode?: string;
      flightNumber?: number;
      fromAirportCode?: string;
      toAirportCode?: string;
      departureDate?: string;
      departureTime?: string;
      arrivalDate?: string;
      arrivalTime?: string;
      bookingClass?: string;
      cabinTypeName?: string;
      flightStatusCode?: string;
      flightStatusName?: string;
    }[];
    hotels?: {
      hotelName?: string;
      confirmationId?: string;
      checkInDate?: string;
      checkOutDate?: string;
      paymentPolicy?: string;
      room?: {
        roomType?: string;
        description?: string;
        roomRate?: { amount?: string; currencyCode?: string };
      };
    }[];
  };

  const file = await saveFixture(`getbooking-${reference}`, { response: result.raw });
  const flights = (b.flights ?? []).map((f) => ({
    segment: `${f.airlineCode}${f.flightNumber} ${f.fromAirportCode}→${f.toAirportCode}`,
    departs: `${f.departureDate} ${f.departureTime?.slice(0, 5)}`,
    arrives: `${f.arrivalDate} ${f.arrivalTime?.slice(0, 5)}`,
    cabin: f.cabinTypeName,
    class: f.bookingClass,
    status: `${f.flightStatusCode} (${f.flightStatusName})`,
  }));
  const hotels = (b.hotels ?? []).map((h) => ({
    property: h.hotelName,
    vendorConfirmation: h.confirmationId,
    checkIn: h.checkInDate,
    checkOut: h.checkOutDate,
    nights:
      h.checkInDate && h.checkOutDate
        ? Math.round((Date.parse(h.checkOutDate) - Date.parse(h.checkInDate)) / 86_400_000)
        : undefined,
    room: h.room?.roomType,
    nightlyRate: h.room?.roomRate
      ? `${h.room.roomRate.amount} ${h.room.roomRate.currencyCode}`
      : undefined,
    paymentPolicy: h.paymentPolicy,
  }));

  console.log(
    JSON.stringify(
      {
        ok: true,
        reference,
        bookingId: b.bookingId,
        holds: { from: b.startDate, to: b.endDate },
        isTicketed: b.isTicketed,
        isCancelable: b.isCancelable,
        travelers: (b.travelers ?? []).map((t) => `${t.givenName} ${t.surname}`),
        flights,
        hotels,
        allSegmentsConfirmed:
          flights.length > 0 ? flights.every((f) => f.status.startsWith('HK')) : undefined,
        file,
        requests,
      },
      null,
      2,
    ),
  );
}

/** Cancels an order and proves the outcome with Get Booking. */
async function cancel() {
  const [reference] = args;
  if (!reference) throw new Error('usage: cancel <reference>');
  const provider = new SabreProvider();

  const before = await retrieveBooking(reference).catch(() => null);
  const beforeCounts = before
    ? (() => {
        const b = before.raw as { flights?: unknown[]; hotels?: unknown[] };
        return { flights: b.flights?.length ?? 0, hotels: b.hotels?.length ?? 0 };
      })()
    : null;

  const { result, requests } = await withProviderTrace(() => provider.cancelBooking(reference));
  const file = await saveFixture(`cancel-${reference}`, { response: result.raw });
  console.log(
    JSON.stringify(
      {
        ok: result.cancelled,
        reference,
        before: beforeCounts,
        cancelled: result.cancelled,
        remaining: result.remaining,
        file,
        requests,
      },
      null,
      2,
    ),
  );
  if (!result.cancelled) process.exitCode = 1;
}

const commands: Record<string, () => Promise<void>> = {
  e2e,
  lookup,
  cancel,
  auth,
  flights,
  'hotels-geo': hotelsGeo,
  'hotels-beta': hotelsBeta,
  'hotels-probe': hotelsProbe,
  hotel,
  pricecheck,
};

const run = commands[cmd];
if (!run) {
  console.error(`Unknown command "${cmd}". Available: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
run().catch((e) => {
  console.error(
    JSON.stringify({ ok: false, error: e?.toJSON?.() ?? String(e), details: e?.details }, null, 2),
  );
  process.exit(1);
});
