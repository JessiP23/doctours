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

/** The single affordance that opens and closes the panel. */
export function PanelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3 5.5h14M3 10h14M3 14.5h14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
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
        <div className="flex items-center gap-2 border-b border-line px-3 py-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close trips"
            className="rounded-lg p-2 text-muted transition hover:bg-them hover:text-ink"
          >
            <PanelIcon />
          </button>
          <h2 className="text-[15px] font-semibold">Your trips</h2>
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
