import { getEnv } from '@/lib/env';
import { ping } from '@/lib/db/repo';
import { getAccessToken, tokenExpiresAt } from '@/lib/providers/sabre/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health — confirms configuration, database connectivity and Sabre auth.
 * Never returns secrets. Used after every deploy before touching the chat.
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    const env = getEnv();
    checks.env = {
      ok: true,
      detail: `model=${env.ANTHROPIC_MODEL} sabre=${new URL(env.SABRE_BASE_URL).host}`,
    };
  } catch (e) {
    checks.env = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  try {
    await ping();
    checks.database = { ok: true };
  } catch (e) {
    checks.database = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  try {
    await getAccessToken();
    checks.sabre = { ok: true, detail: `token valid until ${tokenExpiresAt()?.toISOString()}` };
  } catch (e) {
    checks.sabre = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return Response.json({ ok, checks, at: new Date().toISOString() }, { status: ok ? 200 : 503 });
}
