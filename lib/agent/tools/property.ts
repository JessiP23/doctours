import type { PropertyLocation } from '@/lib/providers/types';
import { resolveAirportPoint } from '@/lib/providers/sabre';
import { describeDistance } from '@/lib/trip/geo';

export interface PropertyDescription {
  address?: string;
  phone?: string;
  coordinates?: { latitude: number; longitude: number };
  distanceFromArrival?: {
    airport: string;
    km: number;
    miles: number;
    note: string;
  };
}

/**
 * What the agent can truthfully say about where a property is.
 *
 * Every field is present only when the provider gave it: an address with no
 * street line is no address, and a distance needs both points. A patient asking
 * "where is it and how far from where I land" should get the answer or a plain
 * "I don't have that", never something filled in from general knowledge.
 *
 * Works for any property and any arrival airport — the address comes from the room
 * search that already ran, and the airport is resolved by code.
 */
export async function describeProperty(
  location: PropertyLocation | null,
  arrivalAirport: string | undefined,
): Promise<PropertyDescription | null> {
  if (!location) return null;

  const description: PropertyDescription = {};

  const parts = [
    ...location.addressLines,
    [location.city, location.postalCode].filter(Boolean).join(' ').trim(),
    location.country,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (parts.length > 0) description.address = parts.join(', ');
  if (location.phone) description.phone = location.phone;
  if (location.coords) description.coordinates = location.coords;

  if (location.coords && arrivalAirport) {
    const airport = await resolveAirportPoint(arrivalAirport);
    if (airport) {
      description.distanceFromArrival = {
        airport: arrivalAirport.toUpperCase(),
        ...describeDistance(airport, location.coords),
      };
    }
  }

  return Object.keys(description).length > 0 ? description : null;
}
