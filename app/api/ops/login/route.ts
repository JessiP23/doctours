import { cookies } from 'next/headers';
import { OPS_COOKIE, opsEnabled, opsTokenValid } from '@/lib/ops/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/ops/login — presents the operator token once; the cookie carries it after. */
export async function POST(request: Request) {
  if (!opsEnabled()) return new Response('Operator console is not enabled', { status: 404 });

  const form = await request.formData();
  const token = form.get('token');
  if (typeof token !== 'string' || !opsTokenValid(token)) {
    return Response.redirect(new URL('/ops?denied=1', request.url), 303);
  }

  const store = await cookies();
  store.set(OPS_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  return Response.redirect(new URL('/ops', request.url), 303);
}
