import type { ToolDefinition } from './define';
import { toAnthropicTool } from './define';
import { replyTool } from './reply';
import { getTripStateTool } from './get_trip_state';
import { searchFlightsTool } from './search_flights';
import { createFlightOrderTool } from './create_flight_order';
import { searchHotelRatesTool } from './search_hotel_rates';
import { createHotelBookingTool } from './create_hotel_booking';

/**
 * Tool registry. Booking tools register here as they land; the loop only ever
 * consults this list. Order matters slightly: the model reads it top to bottom.
 */
const registry: ToolDefinition[] = [
  getTripStateTool,
  searchFlightsTool,
  createFlightOrderTool,
  searchHotelRatesTool,
  createHotelBookingTool,
  replyTool,
];

export function registerTools(...tools: ToolDefinition[]): void {
  for (const t of tools) {
    if (registry.some((r) => r.name === t.name))
      throw new Error(`Tool "${t.name}" already registered`);
    registry.push(t);
  }
}

export function listTools(): readonly ToolDefinition[] {
  return registry;
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.find((t) => t.name === name);
}

export function anthropicTools() {
  return registry.map(toAnthropicTool);
}
