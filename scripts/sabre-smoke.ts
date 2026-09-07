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
 *
 * Raw responses are written to tests/fixtures/sabre/<name>.json so mappers can be
 * written and unit-tested against real payloads.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getEnv } from '@/lib/env';
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

const commands: Record<string, () => Promise<void>> = {
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
