/**
 * Keeps assistant output human: plain text, short, one thought per bubble.
 * Applied server-side to every reply so the UI never has to defend itself.
 */
export const MAX_BUBBLES = 4;
export const MAX_BUBBLE_CHARS = 240;

/** Removes markdown syntax while keeping the words. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '')) // code fences → inner text
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '') // headers
    .replace(/^[ \t]*>[ \t]?/gm, '') // blockquotes
    .replace(/^[ \t]*[-*+][ \t]+/gm, '') // bullets
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, '') // numbered lists
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2') // italics
    .replace(/~~(.*?)~~/g, '$1') // strikethrough
    .replace(/^[ \t]*([-*_][ \t]?){3,}[ \t]*$/gm, '') // horizontal rules
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits text into sentences, keeping abbreviations like "8:00 p.m." and prices intact. */
export function splitSentences(text: string): string[] {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g);
  return (parts ?? [text]).map((s) => s.trim()).filter(Boolean);
}

/** Splits an over-long bubble at sentence boundaries into chunks ≤ max chars. */
export function chunkBubble(text: string, max = MAX_BUBBLE_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let current = '';
  for (const sentence of splitSentences(text)) {
    if (sentence.length > max) {
      if (current) out.push(current);
      current = '';
      // hard-wrap a single very long sentence on word boundaries
      let rest = sentence;
      while (rest.length > max) {
        const cut = rest.lastIndexOf(' ', max);
        const at = cut > 0 ? cut : max;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      current = rest;
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > max) {
      out.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Normalizes a list of candidate bubbles: strips markdown, drops empties,
 * splits over-long ones, and caps the count (merging the tail if necessary
 * rather than dropping information).
 */
export function humanizeBubbles(
  bubbles: string[],
  opts: { maxBubbles?: number; maxChars?: number } = {},
): string[] {
  const maxBubbles = opts.maxBubbles ?? MAX_BUBBLES;
  const maxChars = opts.maxChars ?? MAX_BUBBLE_CHARS;

  const cleaned = bubbles
    .flatMap((b) => stripMarkdown(b).split(/\n{2,}/)) // paragraphs become separate bubbles
    .map((b) => b.replace(/\n/g, ' ').trim())
    .filter(Boolean)
    .flatMap((b) => chunkBubble(b, maxChars));

  if (cleaned.length <= maxBubbles) return cleaned;
  const head = cleaned.slice(0, maxBubbles - 1);
  const tail = cleaned.slice(maxBubbles - 1).join(' ');
  return [...head, ...chunkBubble(tail, maxChars).slice(0, 1)];
}

/** Fallback when the model produced free text instead of calling `reply`. */
export function textToBubbles(text: string): string[] {
  const clean = stripMarkdown(text);
  const paragraphs = clean
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter(Boolean);
  if (paragraphs.length > 1) return humanizeBubbles(paragraphs);
  const sentences = splitSentences(clean);
  // group sentences into ~2-sentence bubbles
  const grouped: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) grouped.push(sentences.slice(i, i + 2).join(' '));
  return humanizeBubbles(grouped);
}
