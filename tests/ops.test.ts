import { describe, expect, it, vi } from 'vitest';

/**
 * The operator console plays the parties the Sabre sandbox cannot: the airline, the
 * hotel. Its whole safety argument is that it writes events and nothing else, so
 * these assert the action list is closed, every action is labelled for a button, and
 * an unknown action is refused before anything runs.
 */
vi.mock('@/lib/db/repo', () => ({
  listOpenTripEvents: vi.fn(async () => [{ id: 'e1' }, { id: 'e2' }]),
  acknowledgeTripEvents: vi.fn(async () => undefined),
  getLiveBooking: vi.fn(async () => null),
}));
vi.mock('@/lib/providers/sabre', () => ({ retrieveBooking: vi.fn() }));

const { OPS_ACTIONS, isOpsAction, runOpsAction } = await import('@/lib/ops/actions');

describe('operator actions', () => {
  it('is a closed, labelled list', () => {
    const names = Object.keys(OPS_ACTIONS);
    expect(names).toEqual([
      'cancel-outbound',
      'cancel-return',
      'delay-outbound',
      'delay-return',
      'hotel-cancelled',
      'check',
      'ack',
    ]);
    for (const name of names) {
      expect(OPS_ACTIONS[name as keyof typeof OPS_ACTIONS].label.length).toBeGreaterThan(8);
    }
  });

  it('refuses an action it does not know', () => {
    expect(isOpsAction('cancel-outbound')).toBe(true);
    expect(isOpsAction('drop-database')).toBe(false);
    expect(isOpsAction('')).toBe(false);
  });

  it('clears open events through the same repository call the CLI uses', async () => {
    const result = (await runOpsAction('ack', 'c1')) as { acknowledged: number };
    expect(result.acknowledged).toBe(2);
  });

  it('will not simulate a cancellation on a trip with nothing booked', async () => {
    await expect(runOpsAction('hotel-cancelled', 'c1')).rejects.toThrow(/No room is booked/);
    await expect(runOpsAction('cancel-outbound', 'c1')).rejects.toThrow(/No flight is booked/);
  });
});
