export interface BubbleProps {
  role: 'user' | 'assistant';
  text: string;
  animate?: boolean;
}

export function Bubble({ role, text, animate }: BubbleProps) {
  const mine = role === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[82%] sm:max-w-[70%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words shadow-sm',
          mine
            ? 'bg-me text-me-ink rounded-br-md'
            : 'bg-them text-ink border border-line rounded-bl-md',
          animate ? 'bubble-in' : '',
        ].join(' ')}
      >
        {text}
      </div>
    </div>
  );
}
