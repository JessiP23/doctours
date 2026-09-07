import { describe, expect, it } from 'vitest';
import {
  chunkBubble,
  humanizeBubbles,
  splitSentences,
  stripMarkdown,
  textToBubbles,
} from '@/lib/text/humanize';

describe('stripMarkdown', () => {
  it('removes headers, bullets, bold, links and code', () => {
    const md =
      '## Options\n\n- **Turkish** at $742 — see [details](http://x)\n- `TK1` non-stop\n\n1. first\n2. second';
    expect(stripMarkdown(md)).toBe(
      'Options\n\nTurkish at $742 — see details\nTK1 non-stop\n\nfirst\nsecond',
    );
  });
  it('keeps prices and times intact', () => {
    expect(stripMarkdown('Lands 4:15 pm, costs $1,240.50.')).toBe(
      'Lands 4:15 pm, costs $1,240.50.',
    );
  });
});

describe('splitSentences', () => {
  it('splits on terminal punctuation', () => {
    expect(splitSentences('Cheapest is $742. It lands at 4:15 pm! Want it?')).toEqual([
      'Cheapest is $742.',
      'It lands at 4:15 pm!',
      'Want it?',
    ]);
  });
});

describe('chunkBubble', () => {
  it('returns short text untouched', () => {
    expect(chunkBubble('Hi there.', 50)).toEqual(['Hi there.']);
  });
  it('splits at sentence boundaries under the limit', () => {
    const chunks = chunkBubble(
      'One sentence here. Another sentence here. A third sentence here.',
      45,
    );
    expect(chunks.every((c) => c.length <= 45)).toBe(true);
    expect(chunks.join(' ')).toBe(
      'One sentence here. Another sentence here. A third sentence here.',
    );
  });
  it('hard-wraps a single overlong sentence on word boundaries', () => {
    const chunks = chunkBubble('word '.repeat(30).trim(), 24);
    expect(chunks.every((c) => c.length <= 24)).toBe(true);
  });
});

describe('humanizeBubbles', () => {
  it('drops empties, strips markdown and caps count without losing text', () => {
    const out = humanizeBubbles(['**Hello**', '', 'a', 'b', 'c', 'd', 'e']);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe('Hello');
    expect(out[3]).toBe('c d e');
  });
  it('turns paragraphs into separate bubbles', () => {
    expect(humanizeBubbles(['First thought.\n\nSecond thought.'])).toEqual([
      'First thought.',
      'Second thought.',
    ]);
  });
});

describe('textToBubbles', () => {
  it('groups sentences two per bubble', () => {
    expect(textToBubbles('One. Two. Three. Four. Five.')).toEqual([
      'One. Two.',
      'Three. Four.',
      'Five.',
    ]);
  });
});
