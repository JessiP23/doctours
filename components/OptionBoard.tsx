'use client';

import type { FlightCard, HotelCard, OptionBoard, RoomCard } from '@/lib/agent/board';

/**
 * The options, side by side.
 *
 * Opens beside the chat when the agent has put two or more things on the table.
 * Every card is an offer the agent already described — same ids, same prices — with
 * the facts a patient compares on made visible: where a flight lands against the
 * deadline, the nights it implies, the total with a room for those nights. Choosing
 * a card does not book anything: it says so in the chat, in words, and the agent
 * takes it from there through the same confirm-then-book path as a typed message.
 * The conversation stays the interface; this is a clearer way to read it.
 */
export interface OptionBoardProps {
  board: OptionBoard;
  busy: boolean;
  onPick: (text: string) => void;
  onClose: () => void;
}

const fmtTime = (local: string) => {
  const d = new Date(local);
  return isNaN(d.getTime())
    ? local
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
};
const fmtDate = (day: string) =>
  new Date(`${day}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'me' }) {
  return (
    <span
      className={
        tone === 'me'
          ? 'rounded-full bg-me/10 px-2 py-0.5 text-[11px] font-medium text-me'
          : 'rounded-full border border-line px-2 py-0.5 text-[11px] text-muted'
      }
    >
      {children}
    </span>
  );
}

function Pick({
  card,
  busy,
  onPick,
  label,
}: {
  card: { pick: string; booked?: string | null; expired?: boolean };
  busy: boolean;
  onPick: (text: string) => void;
  label: string;
}) {
  if (card.booked) {
    return (
      <div className="mt-3 rounded-xl bg-me/10 px-3 py-2 text-center text-xs font-medium text-me">
        Booked · {card.booked}
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={busy || card.expired}
      onClick={() => onPick(card.pick)}
      className="mt-3 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition hover:border-me hover:text-me disabled:opacity-40"
    >
      {card.expired ? 'Price expired — ask again' : label}
    </button>
  );
}

function Flight({
  card,
  board,
  busy,
  onPick,
}: { card: FlightCard; board: OptionBoard } & Omit<OptionBoardProps, 'board' | 'onClose'>) {
  const deadline = fmtTime(board.rules.mustArriveByLocal);
  return (
    <article className="flex w-56 shrink-0 flex-col rounded-2xl border border-line bg-them p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{card.carrier}</span>
        <span className="text-lg font-semibold">{usd(card.priceUSD)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {card.badges.map((b) => (
          <Badge key={b} tone={b === 'cheapest' ? 'me' : 'muted'}>
            {b}
          </Badge>
        ))}
      </div>
      <dl className="mt-3 space-y-2 text-[13px] leading-snug">
        <div>
          <dt className="text-muted">Out</dt>
          <dd>
            {fmtTime(card.outbound.departLocal)} → {fmtTime(card.outbound.arriveLocal)}
            <span className="text-muted">
              {' · '}
              {card.outbound.stops === 0
                ? 'non-stop'
                : `${card.outbound.stops} stop via ${card.outbound.via.join(', ')}`}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-muted">Back</dt>
          <dd>
            {fmtTime(card.inbound.departLocal)} → {fmtTime(card.inbound.arriveLocal)}
            <span className="text-muted">
              {' · '}
              {card.inbound.stops === 0
                ? 'non-stop'
                : `${card.inbound.stops} stop via ${card.inbound.via.join(', ')}`}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-muted">Against your dates</dt>
          <dd>
            {card.hoursBeforeDeadline !== null
              ? card.hoursBeforeDeadline >= 0
                ? `Lands ${card.hoursBeforeDeadline}h before the ${deadline} deadline`
                : `Lands after the ${deadline} deadline`
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Hotel nights</dt>
          <dd>
            {card.nights} · {fmtDate(card.checkIn)} → {fmtDate(card.checkOut)}
          </dd>
        </div>
        {card.room ? (
          <div className="rounded-lg bg-surface px-2.5 py-2">
            <dt className="text-muted">With {card.room.name}</dt>
            <dd className="font-semibold">
              {usd(card.tripTotalUSD as number)}{' '}
              <span className="font-normal text-muted">trip total</span>
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="flex-1" />
      <Pick card={card} busy={busy} onPick={onPick} label="Take this flight" />
    </article>
  );
}

function Room({
  card,
  busy,
  onPick,
}: { card: RoomCard } & Omit<OptionBoardProps, 'board' | 'onClose'>) {
  return (
    <article className="flex w-56 shrink-0 flex-col rounded-2xl border border-line bg-them p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{card.name}</span>
        <span className="text-lg font-semibold">{usd(card.totalUSD)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {card.badges.map((b) => (
          <Badge key={b} tone={b === 'cheapest' ? 'me' : 'muted'}>
            {b}
          </Badge>
        ))}
      </div>
      <dl className="mt-3 space-y-2 text-[13px] leading-snug">
        <div>
          <dt className="text-muted">Nights</dt>
          <dd>
            {card.nights} at {usd(card.nightlyUSD)}
            {card.checkIn && card.checkOut
              ? ` · ${fmtDate(card.checkIn)} → ${fmtDate(card.checkOut)}`
              : ''}
          </dd>
        </div>
        {card.beds.length > 0 ? (
          <div>
            <dt className="text-muted">Beds</dt>
            <dd>
              {card.beds.join(', ')}
              {card.sleeps ? ` · sleeps ${card.sleeps}` : ''}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-muted">Cancellation</dt>
          <dd>
            {card.refundable === null
              ? 'not stated'
              : card.refundable
                ? 'refundable'
                : 'non-refundable'}
          </dd>
        </div>
      </dl>
      <div className="flex-1" />
      <Pick card={card} busy={busy} onPick={onPick} label="Take this room" />
    </article>
  );
}

function Hotel({
  card,
  busy,
  onPick,
}: { card: HotelCard } & Omit<OptionBoardProps, 'board' | 'onClose'>) {
  return (
    <article className="flex w-56 shrink-0 flex-col rounded-2xl border border-line bg-them p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{card.name}</span>
        {card.leadTotalUSD !== null ? (
          <span className="text-lg font-semibold">{usd(card.leadTotalUSD)}</span>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {card.badges.map((b) => (
          <Badge key={b} tone={b === 'current' ? 'me' : 'muted'}>
            {b}
          </Badge>
        ))}
      </div>
      <dl className="mt-3 space-y-2 text-[13px] leading-snug">
        {card.leadNightlyUSD !== null ? (
          <div>
            <dt className="text-muted">From</dt>
            <dd>
              {usd(card.leadNightlyUSD)} a night{card.nights ? ` · ${card.nights} nights` : ''}
            </dd>
          </div>
        ) : null}
        {card.distance ? (
          <div>
            <dt className="text-muted">Distance</dt>
            <dd>{card.distance}</dd>
          </div>
        ) : null}
        {card.address ? (
          <div>
            <dt className="text-muted">Address</dt>
            <dd>{card.address}</dd>
          </div>
        ) : null}
      </dl>
      <div className="flex-1" />
      {card.isCurrentHotel ? (
        <div className="mt-3 rounded-xl bg-me/10 px-3 py-2 text-center text-xs font-medium text-me">
          Your current hotel
        </div>
      ) : (
        <Pick card={card} busy={busy} onPick={onPick} label="Stay here" />
      )}
    </article>
  );
}

function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:thin]">{children}</div>
    </section>
  );
}

export function OptionBoardPanel({ board, busy, onPick, onClose }: OptionBoardProps) {
  const t = board.rules.travellers;
  return (
    <aside className="flex h-full w-full flex-col border-l border-line bg-bg lg:w-1/2 lg:shrink-0">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-3">
        <div>
          <div className="text-[15px] font-semibold">Compare options</div>
          <div className="text-xs text-muted">
            The same options the coordinator described, side by side. Prices are for {t}{' '}
            {t === 1 ? 'traveller' : 'travellers'}. Choosing one just says so in the chat.
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 text-muted transition hover:bg-them hover:text-ink"
          aria-label="Close comparison"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-3">
        {board.flights.length > 0 ? (
          <Row
            title="Flights"
            hint={`land by ${fmtTime(board.rules.mustArriveByLocal)}, leave after ${fmtTime(board.rules.earliestReturnDepartureLocal)}`}
          >
            {board.flights.map((c) => (
              <Flight key={c.id} card={c} board={board} busy={busy} onPick={onPick} />
            ))}
          </Row>
        ) : null}
        {board.rooms.length > 0 ? (
          <Row title={`Rooms at ${board.rules.hotel}`} hint="totals include taxes">
            {board.rooms.map((c) => (
              <Room key={c.id} card={c} busy={busy} onPick={onPick} />
            ))}
          </Row>
        ) : null}
        {board.hotels.length > 0 ? (
          <Row title="Other hotels" hint="as quoted for your nights">
            {board.hotels.map((c) => (
              <Hotel key={c.id} card={c} busy={busy} onPick={onPick} />
            ))}
          </Row>
        ) : null}
      </div>
    </aside>
  );
}
