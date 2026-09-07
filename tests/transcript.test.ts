import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
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
