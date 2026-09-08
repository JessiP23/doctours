import { after } from 'next/server';
import { opsAuthorised, opsEnabled } from '@/lib/ops/auth';
import { isOpsAction, runOpsAction, tellThePatient } from '@/lib/ops/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Actions after which the agent should reach out, rather than wait to be asked. */
const TELLS_THE_PATIENT = new Set([
  'cancel-outbound',
  'cancel-return',
  'delay-outbound',
  'delay-return',
  'hotel-cancelled',
  'check',
]);

/**
 * POST /api/ops/<action> — one operator action on one trip, then back to the console.
 *
 * Plain form posts and redirects, no client JavaScript: the console is a tool for
 * one person on camera, and a page that works with the network tab open is easier
 * to trust than one that does not.
 */
export async function POST(request: Request, ctx: { params: Promise<{ action: string }> }) {
  if (!opsEnabled()) return new Response('Operator console is not enabled', { status: 404 });
  if (!(await opsAuthorised())) return new Response('Forbidden', { status: 403 });

  const { action } = await ctx.params;
  if (!isOpsAction(action)) return new Response(`Unknown action ${action}`, { status: 404 });

  const form = await request.formData();
  const conversationId = form.get('conversationId');
  if (typeof conversationId !== 'string' || !/^[0-9a-f-]{36}$/.test(conversationId)) {
    return new Response('conversationId required', { status: 400 });
  }

  const back = new URL('/ops', request.url);
  try {
    const result = await runOpsAction(action, conversationId);
    // The console answers at once; the agent's turn runs after the response so the
    // operator is not held for twenty seconds, and the chat shows it thinking.
    if (TELLS_THE_PATIENT.has(action)) after(() => tellThePatient(conversationId));
    back.searchParams.set('did', action);
    back.searchParams.set('on', conversationId.slice(0, 8));
    back.searchParams.set('result', JSON.stringify(result).slice(0, 400));
  } catch (e) {
    back.searchParams.set('error', e instanceof Error ? e.message : String(e));
  }
  return Response.redirect(back, 303);
}
