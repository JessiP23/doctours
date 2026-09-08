import type { GeoPoint } from '@/lib/providers/types';

/**
 * How far apart two places are.
 *
 * Two patients asked how far the hotel is from where they land, and the answer was
 * already in the data: the room search returns the property's coordinates, and the
 * provider resolves an airport code to a point. This turns those into a number the
 * agent can state without guessing.
 *
 * Great-circle distance, which is the distance through the air, not by road. That
 * distinction matters enough to say out loud rather than dress up as a drive time —
 * a road distance and a journey time are things no tool here returns.
 */
const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const KM_PER_MILE = 1.609344;

/** Rounded to whole units: the precision the maths gives is not the precision reality has. */
export function describeDistance(a: GeoPoint, b: GeoPoint) {
  const km = distanceKm(a, b);
  return {
    km: Math.round(km),
    miles: Math.round(km / KM_PER_MILE),
    note: 'Straight-line distance between the two points, not a road distance or a journey time.',
  };
}
