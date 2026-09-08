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

/** `from '…'` misses side-effect imports, and `import 'server-only'` is exactly one. */
const allImports = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1]);

/** Resolve a `@/…` specifier to the file it actually loads, or null for packages. */
function resolveLocal(specifier: string): string | null {
  if (!specifier.startsWith('@/')) return null;
  const base = path.resolve(process.cwd(), specifier.slice(2));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this shape; try the next one.
    }
  }
  return null;
}

/** Every local module a set of entry points can reach, transitively. */
function reachableFrom(entries: string[]): string[] {
  const seen = new Set(entries);
  const queue = [...entries];
  while (queue.length) {
    for (const specifier of allImports(queue.pop()!)) {
      const target = resolveLocal(specifier);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return [...seen];
}

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

  it('the CLI scripts can load their whole module graph', () => {
    // `server-only` throws on import outside a React Server Component, so any
    // script that reaches `lib/db/repo` dies at load — which is how `trips`,
    // `check` and `disrupt` shipped broken. Scripts are server-side by
    // definition, so `tsconfig.scripts.json` maps the marker to a no-op stub.
    // This asserts the escape hatch still exists whenever a script needs it.
    const graph = reachableFrom(filesIn('scripts'));
    const marked = graph.filter((file) => allImports(file).includes('server-only'));
    if (marked.length === 0) return;

    const scriptsConfig = JSON.parse(readFileSync('tsconfig.scripts.json', 'utf8'));
    const mapped = scriptsConfig.compilerOptions?.paths?.['server-only'];
    expect(
      mapped,
      `scripts reach server-only code (${marked
        .map((f) => path.relative(process.cwd(), f))
        .join(', ')}) but tsconfig.scripts.json does not neutralise it`,
    ).toBeTruthy();
    const stub = readFileSync(path.resolve(process.cwd(), mapped[0]), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(stub, 'the server-only stub must be inert').not.toMatch(/\bthrow\b/);
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
