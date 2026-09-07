/**
 * Sabre CERT smoke script — run BEFORE building the agent.
 *
 *   npx tsx --env-file=.env.local scripts/sabre-smoke.ts auth
 *
 * Subcommands are added as provider capabilities land (flights, hotels, book).
 * Raw responses are written to tests/fixtures/sabre/ so mappers can be unit-tested.
 */
import { getAccessToken, tokenExpiresAt } from '@/lib/providers/sabre/auth';
import { withProviderTrace } from '@/lib/providers/trace';

const [cmd = 'auth'] = process.argv.slice(2);

async function auth() {
  const { result, requests } = await withProviderTrace(async () => getAccessToken());
  console.log(
    JSON.stringify(
      { ok: true, tokenPreview: `${result.slice(0, 12)}…`, expiresAt: tokenExpiresAt(), requests },
      null,
      2,
    ),
  );
}

const commands: Record<string, () => Promise<void>> = { auth };

const run = commands[cmd];
if (!run) {
  console.error(`Unknown command "${cmd}". Available: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
run().catch((e) => {
  console.error(
    JSON.stringify({ ok: false, error: e?.toJSON?.() ?? String(e), details: e?.details }, null, 2),
  );
  process.exit(1);
});
