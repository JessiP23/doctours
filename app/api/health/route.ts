import Anthropic from '@anthropic-ai/sdk';
import { getEnv, paymentCard } from '@/lib/env';
import { checkSchema } from '@/lib/db/repo';
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
      detail: `model=${env.ANTHROPIC_MODEL} sabre=${new URL(env.SABRE_BASE_URL).host} agencyCard=${paymentCard(env) ? 'configured' : 'MISSING (hotel deposits will fail)'}`,
    };
  } catch (e) {
    checks.env = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  try {
    const schema = await checkSchema();
    checks.database = schema.ok
      ? { ok: true, detail: `${schema.present.length} tables present` }
      : {
          ok: false,
          detail: `missing or unreadable: ${schema.missing.map((m) => m.table).join(', ')}. Apply supabase/migrations/0001_init.sql. First error: ${schema.missing[0]?.message}`,
        };
  } catch (e) {
    checks.database = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  try {
    await getAccessToken();
    checks.sabre = { ok: true, detail: `token valid until ${tokenExpiresAt()?.toISOString()}` };
  } catch (e) {
    checks.sabre = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  // Verifies the configured model id exists and the key can see it, without
  // spending a completion — a wrong id would otherwise only fail mid-conversation.
  try {
    const env = getEnv();
    const model = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).models.retrieve(
      env.ANTHROPIC_MODEL,
    );
    checks.anthropic = { ok: true, detail: `${model.id} reachable` };
  } catch (e) {
    checks.anthropic = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return Response.json({ ok, checks, at: new Date().toISOString() }, { status: ok ? 200 : 503 });
}
