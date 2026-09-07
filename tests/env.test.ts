import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEnv, resetEnvForTests } from '@/lib/env';

const REQUIRED = {
  ANTHROPIC_API_KEY: 'test-key',
  SABRE_USER_ID: 'V1:123:ABC:AA',
  SABRE_PASSWORD: 'pw',
  SABRE_PCC: 'ABC',
};

describe('env', () => {
  const original = { ...process.env };

  beforeEach(() => {
    resetEnvForTests();
    for (const k of Object.keys(REQUIRED)) delete process.env[k];
    delete process.env.SABRE_BASE_URL;
    delete process.env.SABRE_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env = { ...original };
    resetEnvForTests();
  });

  it('parses a valid environment and applies defaults', () => {
    Object.assign(process.env, REQUIRED);
    const env = getEnv();
    expect(env.SABRE_BASE_URL).toBe('https://api.cert.platform.sabre.com');
    expect(env.SABRE_TIMEOUT_MS).toBe(25_000);
    expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-5');
  });

  it('coerces numeric strings', () => {
    Object.assign(process.env, REQUIRED, { SABRE_TIMEOUT_MS: '5000' });
    expect(getEnv().SABRE_TIMEOUT_MS).toBe(5000);
  });

  it('fails with a readable message when a required variable is missing', () => {
    Object.assign(process.env, REQUIRED, { SABRE_PASSWORD: '' });
    expect(() => getEnv()).toThrowError(/SABRE_PASSWORD/);
  });
});
