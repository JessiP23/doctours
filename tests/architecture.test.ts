import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Layering is what keeps this codebase honest: rules cannot quietly start
 * depending on a provider, tools cannot bypass the provider interface, and the
 * pure modules stay runnable from a script. These are cheap to assert and the
 * violations are expensive to find by hand — one of them already crashed the
 * e2e script when selection logic drifted next to the database layer.
 */
function filesIn(dir: string): string[] {
  const root = path.resolve(process.cwd(), dir);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
    }
  };
  walk(root);
  return out;
}

const imports = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);

describe('layering', () => {
  it('lib/trip is pure: no database, no provider implementation, no server-only', () => {
    for (const file of filesIn('lib/trip')) {
      for (const specifier of imports(file)) {
        expect(specifier, `${path.basename(file)} imports ${specifier}`).not.toMatch(
          /lib\/db|providers\/sabre|server-only/,
        );
      }
    }
  });

  it('trip rules and validation do not import the agent', () => {
    for (const file of filesIn('lib/trip')) {
      for (const specifier of imports(file)) {
        expect(specifier, path.basename(file)).not.toMatch(/lib\/agent/);
      }
    }
  });

  it('the provider layer never imports the agent or the database', () => {
    for (const file of filesIn('lib/providers')) {
      for (const specifier of imports(file)) {
        expect(specifier, path.basename(file)).not.toMatch(/lib\/agent|lib\/db/);
      }
    }
  });

  it('tools reach Sabre only through the provider entry point, never its internals', () => {
    for (const file of filesIn('lib/agent/tools')) {
      for (const specifier of imports(file)) {
        if (!specifier.includes('providers/sabre')) continue;
        // The entry point and the shared error helpers are the whole public surface.
        expect(specifier, path.basename(file)).toMatch(
          /providers\/sabre$|providers\/sabre\/errors$/,
        );
      }
    }
  });

  it('the client bundle never pulls in server-only code', () => {
    for (const file of filesIn('components')) {
      for (const specifier of imports(file)) {
        expect(specifier, path.basename(file)).not.toMatch(
          /lib\/db|lib\/providers|lib\/agent\/(loop|tools|conversation)/,
        );
      }
    }
  });
});
