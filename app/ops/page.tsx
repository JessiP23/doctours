import { opsAuthorised, opsEnabled } from '@/lib/ops/auth';
import { listTripsForOps, OPS_ACTIONS, type OpsAction } from '@/lib/ops/actions';

export const dynamic = 'force-dynamic';

/**
 * The operator console.
 *
 * This is the airline, the clinic and the hotel — the parties who do things to a
 * patient's trip without asking. The Sabre sandbox cannot originate any of it, so an
 * operator does, here, and the chat reacts on its next turn. It is deliberately not a
 * patient interface and shares nothing with the chat's design: the patient has a
 * conversation, an operator has buttons.
 */
export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  if (!opsEnabled()) {
    return (
      <Shell>
        <p className="text-neutral-300">
          The operator console is off. Set <code className="text-amber-300">OPS_TOKEN</code> in the
          environment to enable it.
        </p>
      </Shell>
    );
  }

  if (!(await opsAuthorised())) {
    return (
      <Shell>
        <form action="/api/ops/login" method="post" className="flex max-w-md flex-col gap-3">
          <label className="text-sm text-neutral-300" htmlFor="token">
            Operator token
          </label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
          />
          {params.denied ? (
            <p className="text-sm text-red-400">That token was not accepted.</p>
          ) : null}
          <button className="rounded bg-amber-500 px-3 py-2 font-medium text-black">Enter</button>
        </form>
      </Shell>
    );
  }

  const trips = await listTripsForOps();
  const flash = flashFrom(params);

  return (
    <Shell>
      {flash}
      <p className="mb-6 max-w-3xl text-sm text-neutral-400">
        Every button writes what a real airline, clinic or hotel notice would write, and nothing
        else — no booking is touched and Sabre is not called, except <em>Re-read</em>, which only
        reads. The patient sees the result the next time they say anything in the chat.
      </p>

      {trips.length === 0 ? (
        <p className="text-neutral-400">No trips yet.</p>
      ) : (
        <ul className="flex flex-col gap-6">
          {trips.map((t) => (
            <li key={t.id} className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="font-mono text-xs text-neutral-500">{t.id}</span>
                  <span className="ml-3 text-xs text-neutral-500">
                    started {new Date(t.started).toLocaleString()}
                  </span>
                </div>
                <span className="text-xs text-neutral-400">
                  {t.travellers} traveller{t.travellers === 1 ? '' : 's'}
                </span>
              </div>

              <dl className="mb-3 grid gap-1 text-sm sm:grid-cols-2">
                <Held label="Flight" row={t.flight} />
                <Held label="Hotel" row={t.hotel} />
              </dl>

              {t.history.length > 0 ? (
                <p className="mb-3 text-xs text-neutral-500">
                  History:{' '}
                  {t.history
                    .map((b) => `${b.kind} ${b.booking_reference} (${b.status})`)
                    .join(' · ')}
                </p>
              ) : null}

              {t.openEvents.length > 0 ? (
                <p className="mb-3 text-xs text-amber-300">
                  Untold: {t.openEvents.map((e) => e.kind).join(', ')} — the patient hears it on
                  their next message.
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {(Object.keys(OPS_ACTIONS) as OpsAction[]).map((action) => (
                  <form key={action} action={`/api/ops/${action}`} method="post">
                    <input type="hidden" name="conversationId" value={t.id} />
                    <button
                      className={
                        action === 'ack' || action === 'check'
                          ? 'rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800'
                          : 'rounded bg-red-900/70 px-3 py-1.5 text-sm text-red-100 hover:bg-red-800'
                      }
                      disabled={disabledFor(action, t)}
                    >
                      {OPS_ACTIONS[action].label}
                    </button>
                  </form>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function disabledFor(
  action: OpsAction,
  t: { flight: unknown | null; hotel: unknown | null; openEvents: unknown[] },
): boolean {
  if (action === 'hotel-cancelled') return !t.hotel;
  if (action === 'ack') return t.openEvents.length === 0;
  return !t.flight;
}

function Held({
  label,
  row,
}: {
  label: string;
  row: { booking_reference: string; details: unknown } | null;
}) {
  if (!row) {
    return (
      <>
        <dt className="text-neutral-500">{label}</dt>
        <dd className="text-neutral-500">—</dd>
      </>
    );
  }
  const d = row.details as Record<string, unknown>;
  const summary =
    label === 'Flight'
      ? `${(d.outbound as { departLocal?: string })?.departLocal ?? ''} → ${(d.inbound as { departLocal?: string })?.departLocal ?? ''}`
      : `${d.checkIn ?? ''} → ${d.checkOut ?? ''}`;
  return (
    <>
      <dt className="text-neutral-400">{label}</dt>
      <dd className="text-neutral-100">
        <span className="font-mono">{row.booking_reference}</span>
        <span className="ml-2 text-neutral-400">{summary}</span>
      </dd>
    </>
  );
}

function flashFrom(params: Record<string, string | string[] | undefined>) {
  const one = (k: string) => (Array.isArray(params[k]) ? params[k]?.[0] : params[k]);
  if (one('error')) {
    return (
      <p className="mb-4 rounded border border-red-900 bg-red-950/50 p-3 text-sm text-red-200">
        {one('error')}
      </p>
    );
  }
  if (one('did')) {
    return (
      <p className="mb-4 rounded border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-200">
        <span className="font-medium">{one('did')}</span> on {one('on')}…{' '}
        <code className="text-xs text-emerald-300/80">{one('result')}</code>
      </p>
    );
  }
  return null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100 sm:p-10">
      <header className="mb-6 border-b border-neutral-800 pb-4">
        <h1 className="text-lg font-semibold tracking-tight">Operator console</h1>
        <p className="text-sm text-neutral-400">
          Simulated airline, clinic and hotel. Not a patient surface.
        </p>
      </header>
      {children}
    </main>
  );
}
