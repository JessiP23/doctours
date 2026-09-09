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
vi.mock('@/lib/agent/procedure', () => ({
  moveProcedure: vi.fn(async (_id: string, at: string, source: string) => ({
    move: { was: '2026-10-13T08:00', now: at, flight: null, hotel: null, rules: {}, nextStep: '' },
    event: source === 'patient' ? null : { id: 'e9' },
  })),
}));

const { OPS_ACTIONS, isOpsAction, opsFields, runOpsAction } = await import('@/lib/ops/actions');
const { moveProcedure } = await import('@/lib/agent/procedure');

describe('operator actions', () => {
  it('is a closed, labelled list', () => {
    const names = Object.keys(OPS_ACTIONS);
    expect(names).toEqual([
      'cancel-outbound',
      'cancel-return',
      'delay-outbound',
      'delay-return',
      'hotel-cancelled',
      'procedure-moved',
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

  it('declares the input the clinic action needs, and refuses to run without it', async () => {
    expect(opsFields('procedure-moved').map((f) => f.name)).toEqual(['procedureAtLocal']);
    expect(opsFields('cancel-outbound')).toEqual([]);
    await expect(runOpsAction('procedure-moved', 'c1', {})).rejects.toThrow(
      /procedureAtLocal is required/,
    );
    expect(moveProcedure).not.toHaveBeenCalled();
  });

  it('moves the procedure as the clinic, so the patient has to be told', async () => {
    const result = (await runOpsAction('procedure-moved', 'c1', {
      procedureAtLocal: '2026-10-20T08:00',
    })) as { now: string; eventId: string | null };
    expect(moveProcedure).toHaveBeenCalledWith('c1', '2026-10-20T08:00', 'simulated');
    expect(result.now).toBe('2026-10-20T08:00');
    expect(result.eventId).toBe('e9');
  });

  it('will not simulate a cancellation on a trip with nothing booked', async () => {
    await expect(runOpsAction('hotel-cancelled', 'c1')).rejects.toThrow(/No room is booked/);
    await expect(runOpsAction('cancel-outbound', 'c1')).rejects.toThrow(/No flight is booked/);
  });
});
