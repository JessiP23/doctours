'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bubble } from './Bubble';
import { PanelIcon, TripList, type Trip } from './TripList';
import { TypingIndicator } from './TypingIndicator';
import { OPENING_BUBBLES } from '@/lib/agent/opening';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  animate?: boolean;
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
  const [trips, setTrips] = useState<Trip[]>([]);
  const [showTrips, setShowTrips] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const counter = useRef(0);
  const nextId = () => `local-${++counter.current}`;
  /**
   * Which greeting reveal is current. The opening plays out over a few seconds; if
   * the patient starts a new trip or opens another one mid-reveal, the stale loop
   * must stop appending bubbles — it was re-adding `open-1` on top of the fresh
   * greeting, which is the duplicate-key warning React raised.
   */
  const reveal = useRef(0);
  /**
   * Transcript items already on screen, by server id. The agent can now speak
   * without being spoken to — an airline cancellation reaches the patient the moment
   * it is known, not the next time they type — so the chat polls while idle and
   * reveals only what it has not shown. Locally-sent bubbles carry local ids, so
   * after every turn the server's view is re-read and marked seen without redrawing.
   */
  const seen = useRef<Set<string>>(new Set());
  const polling = useRef(false);

  const markAllSeen = useCallback(async () => {
    try {
      const res = await fetch('/api/conversation', { cache: 'no-store' });
      const data = (await res.json()) as { messages: Message[] };
      for (const m of data.messages) seen.current.add(m.id);
    } catch {
      /* best effort; the next poll will reconcile */
    }
  }, []);

  const opening = (animate = false): Message[] =>
    OPENING_BUBBLES.map((text, i) => ({
      id: `open-${i}`,
      role: 'assistant' as const,
      text,
      animate,
    }));

  const refreshTrips = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations', { cache: 'no-store' });
      const data = (await res.json()) as { trips: Trip[] };
      setTrips(data.trips);
    } catch {
      /* the list is a convenience; never block the chat on it */
    }
  }, []);

  // Hydrate the open trip; play the opening only when it has no history yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/conversation', { cache: 'no-store' });
        const data = (await res.json()) as { messages: Message[] };
        if (cancelled) return;
        if (data.messages.length > 0) {
          for (const m of data.messages) seen.current.add(m.id);
          setMessages([...opening(), ...data.messages]);
        } else {
          const run = ++reveal.current;
          for (const [i, text] of OPENING_BUBBLES.entries()) {
            setTyping(true);
            await sleep(i === 0 ? 500 : revealDelay(text));
            if (cancelled || reveal.current !== run) return;
            setTyping(false);
            setMessages((m) => [...m, { id: `open-${i}`, role: 'assistant', text, animate: true }]);
          }
        }
        void refreshTrips();
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
  }, [refreshTrips]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, typing]);

  // While idle, listen for the agent speaking first.
  useEffect(() => {
    if (!hydrated) return;
    const tick = async () => {
      if (busy || polling.current || document.hidden) return;
      polling.current = true;
      try {
        const res = await fetch('/api/conversation', { cache: 'no-store' });
        const data = (await res.json()) as { messages: Message[]; pendingUpdate: boolean };
        const fresh = data.messages.filter((m) => !seen.current.has(m.id));
        // Anything the patient typed elsewhere is recorded, not replayed.
        for (const m of fresh.filter((m) => m.role === 'user')) seen.current.add(m.id);
        const spoken = fresh.filter((m) => m.role === 'assistant');
        if (spoken.length > 0) {
          for (const [i, m] of spoken.entries()) {
            setTyping(true);
            await sleep(i === 0 ? 600 : revealDelay(m.text));
            seen.current.add(m.id);
            setTyping(false);
            setMessages((prev) => [...prev, { ...m, animate: true }]);
          }
          void refreshTrips();
        } else {
          // Something is untold and the agent has not spoken yet: it is thinking.
          setTyping(data.pendingUpdate);
        }
      } catch {
        /* transient; try again next tick */
      } finally {
        polling.current = false;
      }
    };
    const id = window.setInterval(() => void tick(), 4000);
    return () => window.clearInterval(id);
  }, [hydrated, busy, refreshTrips]);

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
      const data = (await res.json()) as { bubbles: string[] };
      for (const [i, bubble] of data.bubbles.entries()) {
        await sleep(i === 0 ? Math.min(revealDelay(bubble), 900) : revealDelay(bubble));
        setTyping(i < data.bubbles.length - 1);
        setMessages((m) => [
          ...m,
          { id: nextId(), role: 'assistant', text: bubble, animate: true },
        ]);
      }
      void refreshTrips();
      void markAllSeen();
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
  }, [input, busy, refreshTrips, markAllSeen]);

  const startNewTrip = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setShowTrips(false);
    reveal.current++;
    setTyping(false);
    try {
      await fetch('/api/conversations', { method: 'POST' });
      seen.current = new Set();
      setMessages(opening(true));
      void refreshTrips();
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, refreshTrips]);

  const openTrip = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(true);
      setShowTrips(false);
      reveal.current++;
      setTyping(false);
      try {
        const res = await fetch('/api/conversation', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: id }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { messages: Message[] };
        seen.current = new Set(data.messages.map((m) => m.id));
        setMessages([...opening(), ...data.messages]);
        void refreshTrips();
      } finally {
        setBusy(false);
      }
    },
    [busy, refreshTrips],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b border-line bg-bg px-3 py-3">
        <button
          type="button"
          onClick={() => {
            void refreshTrips();
            setShowTrips(true);
          }}
          className="rounded-lg p-2 text-muted transition hover:bg-them hover:text-ink"
          aria-label="Your trips"
        >
          <PanelIcon />
        </button>
        <div className="min-w-0">
          <div className="truncate text-[15px] leading-tight font-semibold">
            Doctours travel coordinator
          </div>
          <div className="truncate text-xs text-muted">
            Doctours travel coordinator · flights and hotel for your Istanbul procedure
          </div>
        </div>
      </header>

      {showTrips && (
        <TripList
          trips={trips}
          busy={busy}
          onSelect={(id) => void openTrip(id)}
          onNew={() => void startNewTrip()}
          onClose={() => setShowTrips(false)}
        />
      )}

      <main className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2.5 px-4 py-5">
          {messages.map((m) => (
            <Bubble key={m.id} role={m.role} text={m.text} animate={m.animate} />
          ))}
          {typing && <TypingIndicator />}
          <div ref={endRef} className="h-1" />
        </div>
      </main>

      <footer className="shrink-0 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)]">
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
