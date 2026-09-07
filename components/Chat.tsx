'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bubble } from './Bubble';
import { TypingIndicator } from './TypingIndicator';
import { OPENING_BUBBLES } from '@/lib/agent/opening';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  animate?: boolean;
}

interface ChatResponse {
  bubbles: string[];
  expectsInput: boolean;
}

/** Reading-speed reveal: a short bubble appears fast, a long one takes a beat. */
function revealDelay(text: string) {
  return Math.min(350 + text.length * 22, 1600);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const counter = useRef(0);
  const nextId = () => `local-${++counter.current}`;

  const scrollToEnd = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  // Hydrate from the server; show the opening if the conversation is new.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/conversation', { cache: 'no-store' });
        const data = (await res.json()) as { messages: Message[] };
        if (cancelled) return;
        if (data.messages.length > 0) {
          setMessages([
            ...OPENING_BUBBLES.map((t, i) => ({
              id: `open-${i}`,
              role: 'assistant' as const,
              text: t,
            })),
            ...data.messages,
          ]);
        } else {
          for (const [i, text] of OPENING_BUBBLES.entries()) {
            setTyping(true);
            await sleep(i === 0 ? 500 : revealDelay(text));
            if (cancelled) return;
            setTyping(false);
            setMessages((m) => [...m, { id: `open-${i}`, role: 'assistant', text, animate: true }]);
          }
        }
      } catch {
        setMessages([
          {
            id: 'err',
            role: 'assistant',
            text: 'I can’t reach the server right now. Give it a moment and refresh?',
          },
        ]);
      } finally {
        if (!cancelled) {
          setTyping(false);
          setHydrated(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(scrollToEnd, [messages, typing, scrollToEnd]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setMessages((m) => [...m, { id: nextId(), role: 'user', text, animate: true }]);
    setTyping(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json()) as ChatResponse;
      for (const [i, bubble] of data.bubbles.entries()) {
        await sleep(i === 0 ? Math.min(revealDelay(bubble), 900) : revealDelay(bubble));
        setTyping(i < data.bubbles.length - 1);
        setMessages((m) => [
          ...m,
          { id: nextId(), role: 'assistant', text: bubble, animate: true },
        ]);
      }
    } catch {
      setMessages((m) => [
        ...m,
        {
          id: nextId(),
          role: 'assistant',
          text: 'Hmm, that didn’t go through. Mind trying again?',
          animate: true,
        },
      ]);
    } finally {
      setTyping(false);
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [input, busy]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-3 px-4 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-me text-me-ink text-sm font-semibold">
            D
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold leading-tight">
              Doctours travel coordinator
            </div>
            <div className="text-xs text-muted">Flights and hotel for your Istanbul procedure</div>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-2.5 px-4 py-5">
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} text={m.text} animate={m.animate} />
        ))}
        {typing && <TypingIndicator />}
        <div ref={endRef} className="h-1" />
      </main>

      <footer className="sticky bottom-0 border-t border-line bg-bg/90 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <form
          className="mx-auto flex w-full max-w-2xl items-end gap-2 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={!hydrated}
            placeholder={hydrated ? 'Message…' : 'Connecting…'}
            aria-label="Message"
            className="max-h-40 min-h-11 flex-1 resize-none rounded-2xl border border-line bg-surface px-4 py-2.5 text-[15px] leading-relaxed outline-none placeholder:text-muted focus:border-me"
          />
          <button
            type="submit"
            disabled={!hydrated || busy || !input.trim()}
            className="h-11 shrink-0 rounded-full bg-me px-4 text-sm font-medium text-me-ink transition disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
