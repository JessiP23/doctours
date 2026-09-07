'use client';

export interface Trip {
  id: string;
  createdAt: string;
  isCurrent: boolean;
  status: 'not started' | 'flight booked' | 'hotel booked' | 'fully booked';
  references: string[];
}

const STATUS_TONE: Record<Trip['status'], string> = {
  'not started': 'text-muted',
  'flight booked': 'text-ink',
  'hotel booked': 'text-ink',
  'fully booked': 'text-me',
};

function when(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export interface TripListProps {
  trips: Trip[];
  busy: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}

export function TripList({ trips, busy, onSelect, onNew, onClose }: TripListProps) {
  return (
    <>
      <button
        type="button"
        aria-label="Close trips"
        className="fixed inset-0 z-20 bg-black/20 sm:bg-black/10"
        onClick={onClose}
      />
      <aside
        className="fixed inset-y-0 left-0 z-30 flex w-[85%] max-w-xs flex-col border-r border-line bg-surface shadow-xl"
        aria-label="Your trips"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold">Your trips</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted hover:text-ink"
            aria-label="Close"
          >
            Close
          </button>
        </div>

        <div className="p-3">
          <button
            type="button"
            onClick={onNew}
            disabled={busy}
            className="w-full rounded-xl bg-me px-4 py-2.5 text-sm font-medium text-me-ink transition disabled:opacity-40"
          >
            Start a new trip
          </button>
        </div>

        <ul className="flex-1 overflow-y-auto px-2 pb-4">
          {trips.length === 0 && <li className="px-2 py-3 text-sm text-muted">No trips yet.</li>}
          {trips.map((trip) => (
            <li key={trip.id}>
              <button
                type="button"
                onClick={() => onSelect(trip.id)}
                disabled={busy || trip.isCurrent}
                className={`w-full rounded-xl px-3 py-2.5 text-left transition hover:bg-them ${
                  trip.isCurrent ? 'bg-them ring-1 ring-line' : ''
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">Istanbul trip</span>
                  <span className="shrink-0 text-xs text-muted">{when(trip.createdAt)}</span>
                </div>
                <div className={`mt-0.5 text-xs ${STATUS_TONE[trip.status]}`}>
                  {trip.status}
                  {trip.references.length > 0 && ` · ${trip.references.join(', ')}`}
                </div>
                {trip.isCurrent && <div className="mt-0.5 text-xs text-muted">open</div>}
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}
