/**
 * Sabre CERT smoke script — run BEFORE building the agent, and whenever the API surprises you.
 *
 *   npm run sabre:smoke -- auth
 *   npm run sabre:smoke -- flights [departDate] [returnDate]     shop JFK→IST round trip, save fixture
 *   npm run sabre:smoke -- hotels-geo [checkIn] [checkOut]       hotels around IST, save fixture
 *   npm run sabre:smoke -- hotel <hotelCode> [checkIn] [checkOut] one property's rates, save fixture
 *   npm run sabre:smoke -- pricecheck <rateKey>                  price check a RateKey → BookingKey
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
} from '@/lib/providers/sabre/requests';
import { withProviderTrace } from '@/lib/providers/trace';
import { TRIP_RULES } from '@/lib/trip/rules';

const [cmd = 'auth', ...args] = process.argv.slice(2);
const FIXTURES = path.resolve(process.cwd(), 'tests/fixtures/sabre');

async function saveFixture(name: string, data: unknown) {
  await mkdir(FIXTURES, { recursive: true });
  const file = path.join(FIXTURES, `${name}.json`);
  await writeFile(file, JSON.stringify(data, null, 2));
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
