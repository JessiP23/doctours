import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
vi.mock('@/lib/db/repo', () => ({}));

import { projectTranscript } from '@/lib/agent/conversation';

describe('projectTranscript', () => {
  it('shows user text and reply bubbles, hides tool plumbing', () => {
    const rows = [
      { id: 1, role: 'user' as const, content: [{ type: 'text', text: 'hi' }], created_at: 't1' },
      {
        id: 2,
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id: 'a', name: 'search_flights', input: {} }],
        created_at: 't2',
      },
      {
        id: 3,
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 'a', content: '{}' }],
        created_at: 't3',
      },
      {
        id: 4,
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_use',
            id: 'b',
            name: 'reply',
            input: { bubbles: ['Found two.', 'Want them?'] },
          },
        ],
        created_at: 't4',
      },
      {
        id: 5,
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 'b', content: 'delivered' }],
        created_at: 't5',
      },
    ];
    expect(projectTranscript(rows).map((m) => [m.role, m.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Found two.'],
      ['assistant', 'Want them?'],
    ]);
  });
});

describe('trip list status', () => {
  it('reads progress from the confirmed bookings of each trip', async () => {
    const { statusOfForTests } = await import('@/lib/agent/conversation');
    const booking = (kind: 'flight' | 'hotel') => ({ kind, status: 'confirmed' }) as never;
    expect(statusOfForTests([])).toBe('not started');
    expect(statusOfForTests([booking('flight')])).toBe('flight booked');
    expect(statusOfForTests([booking('hotel')])).toBe('hotel booked');
    expect(statusOfForTests([booking('flight'), booking('hotel')])).toBe('fully booked');
  });
});

describe('what the patient never sees', () => {
  it('hides system rows and tool plumbing even though they are user-role', async () => {
    const { projectTranscript } = await import('@/lib/agent/conversation');
    const items = projectTranscript([
      {
        id: 1,
        role: 'user',
        kind: 'patient',
        content: [{ type: 'text', text: 'what time do I land?' }],
        created_at: 't',
      },
      {
        id: 2,
        role: 'user',
        kind: 'system',
        content: [{ type: 'text', text: 'Something about this trip has changed…' }],
        created_at: 't',
      },
      {
        // Written before `kind` existed: told apart by the tool_result it carries.
        id: 3,
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: '{}' },
          { type: 'text', text: 'You told the patient "let me find" but…' },
        ],
        created_at: 't',
      },
    ]);
    expect(items.map((i) => i.text)).toEqual(['what time do I land?']);
  });
});
