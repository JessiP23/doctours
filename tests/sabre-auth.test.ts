import { describe, expect, it } from 'vitest';
import { buildBasicCredentials, buildClientId } from '@/lib/providers/sabre/auth';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('sabre auth credential building', () => {
  it('composes V1:<EPR>:<PCC>:<DOMAIN> from a bare EPR', () => {
    expect(buildClientId('91654', 'H1AB', 'AA')).toBe(b64('V1:91654:H1AB:AA'));
  });

  it('composes from a V1:<EPR> prefix without duplicating the V1', () => {
    expect(buildClientId('V1:91654', 'H1AB', 'AA')).toBe(b64('V1:91654:H1AB:AA'));
  });

  it('keeps an already-complete V1 identity untouched', () => {
    expect(buildClientId('V1:91654:H1AB:AA', 'IGNORED', 'ZZ')).toBe(b64('V1:91654:H1AB:AA'));
  });

  it('builds the basic credential as base64(clientId:clientSecret)', () => {
    const expected = b64(`${b64('V1:1:P:AA')}:${b64('secret')}`);
    expect(buildBasicCredentials('1', 'secret', 'P', 'AA')).toBe(expected);
  });
});
