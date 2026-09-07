import type { ToolDefinition } from './define';
import { toAnthropicTool } from './define';
import { replyTool } from './reply';

/**
 * Tool registry. Booking tools register here as they land; the loop only ever
 * consults this list. Order matters slightly: the model reads it top to bottom.
 */
const registry: ToolDefinition[] = [replyTool];

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
