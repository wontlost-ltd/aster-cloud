/**
 * Verify every public route in the Next app has a `config/routes.yaml`
 * entry, and every manifest entry points at a real file (when `source`
 * is set).
 *
 * Two directions of check:
 *   (a) Coverage — every app route must appear in the manifest.
 *       Otherwise a new page can ship without anyone declaring its
 *       ownership status, which is exactly how `/playground` 404s
 *       slipped past review.
 *   (b) Source resolution — manifest entries that declare a `source:`
 *       file must point at something that exists. Catches stale
 *       references (e.g. when a page is moved without updating the
 *       manifest).
 *
 * Out of scope here (Phase 3):
 *   - Cross-site link validation (that walks MDX/JSX bodies)
 *   - `redirect-to` target validation against the other repo
 *
 * Exit:
 *   0 = all routes covered, all sources resolve
 *   1 = coverage gap or unresolved source
 *   2 = infra failure (manifest missing, etc.)
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  routePatternToRegex,
  validateManifest,
  type RoutesManifest,
} from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const YAML_PATH = resolve(REPO_ROOT, 'config', 'routes.yaml');
const APP_LOCALE_ROOT = resolve(REPO_ROOT, 'src', 'app', '[locale]');
const APP_API_ROOT = resolve(REPO_ROOT, 'src', 'app', 'api');

function fail(msg: string, code = 2): never {
  console.error(`::error::${msg}`);
  process.exit(code);
}

/**
 * Convert an absolute file path inside `src/app/[locale]/` to its
 * canonical URL pattern. Rules:
 *   - File must be named `page.tsx` or `page.mdx`.
 *   - Route groups `(name)` are stripped.
 *   - Dynamic segments `[id]` become `:id`.
 *   - Catch-all `[...slug]` becomes `*` (matches the manifest's
 *     wildcard syntax).
 *   - `src/app/[locale]/page.tsx` → `/`.
 *
 * Returns null when the file isn't a page entry.
 */
function appRouteFromFile(absPath: string, root: string, prefix: string): string | null {
  const base = absPath.split('/').pop() ?? '';
  if (base !== 'page.tsx' && base !== 'page.mdx' && base !== 'route.ts') return null;
  const rel = relative(root, dirname(absPath));
  const segments = rel === '' || rel === '.' ? [] : rel.split('/');
  const url = segments
    .filter((seg) => !(seg.startsWith('(') && seg.endsWith(')')))
    .map((seg) => {
      if (seg.startsWith('[...') && seg.endsWith(']')) return '*';
      if (seg.startsWith('[') && seg.endsWith(']')) return `:${seg.slice(1, -1)}`;
      return seg;
    })
    .join('/');
  if (url === '') return prefix || '/';
  return `${prefix}/${url}`;
}

function walkFiles(dir: string, predicate: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const s = statSync(abs);
    if (s.isDirectory()) {
      walkFiles(abs, predicate, out);
    } else if (predicate(entry)) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Routes the verifier intentionally does NOT require to be in the
 * manifest. The manifest's job is to declare ownership of *publicly
 * advertised* URLs — dashboard pages, marketing copy, docs-referenced
 * endpoints. Internal infra (cron, debug, the dashboard's own
 * fetch-the-list-of-X endpoints) is not where dual-site link rot
 * happens, so demanding entries for every JSON endpoint would mostly
 * generate noise.
 *
 * Anything matching one of these patterns is silently skipped. A
 * contributor can still ADD an entry to lock down ownership (e.g.
 * mark an admin API as `auth: admin`); the skip just means absence
 * isn't an error.
 *
 * Categories:
 *   - /api/internal/*  — server-to-server only
 *   - /api/cron/*      — scheduled
 *   - /api/csp-report  — browser CSP reports
 *   - /api/auth/*      — NextAuth.js catch-all
 *   - /api/debug/*     — engineer-only diagnostics
 *   - /api/admin/*     — admin-console backend (the /admin/* PAGE
 *                        entries below DO get checked)
 *   - /api/user/*      — dashboard's own user-data fetches
 *   - /api/notifications, /api/api-keys, /api/teams/*,
 *     /api/policies (non-v1), /api/policy-groups, /api/reports,
 *     /api/approvals
 *                        — dashboard backend; not docs-referenced.
 *                        Docs reference the /api/v1/* surface, which
 *                        IS in the manifest under the v1 wildcard.
 *   - /api/renew/*     — renewal-flow internal endpoint
 *   - /api/license/revoked — license-revocation polling endpoint
 */
const SKIP_PATTERNS: RegExp[] = [
  /^\/api\/internal\//,
  /^\/api\/cron\//,
  /^\/api\/csp-report$/,
  /^\/api\/auth\//,
  /^\/api\/debug\//,
  /^\/api\/admin\//,
  /^\/api\/user\//,
  /^\/api\/notifications(\/|$)/,
  /^\/api\/api-keys(\/|$)/,
  /^\/api\/teams(\/|$)/,
  /^\/api\/policies(\/|$)/,
  /^\/api\/policy-groups(\/|$)/,
  /^\/api\/reports(\/|$)/,
  // 审批收件箱后端：仅供 dashboard 的 cookie 会话调用，文档不引用
  /^\/api\/approvals(\/|$)/,
  /^\/api\/renew(\/|$)/,
  /^\/api\/license\/revoked$/,
  /^\/api\/stripe(\/|$)/,
];

function main(): void {
  if (!existsSync(YAML_PATH)) {
    fail(`config/routes.yaml not found at ${YAML_PATH}`);
  }
  const yaml = readFileSync(YAML_PATH, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (e) {
    fail(`routes.yaml is not valid YAML: ${(e as Error).message}`);
  }
  const { errors } = validateManifest(parsed);
  if (errors.length > 0) {
    for (const err of errors) console.error(`::error::${err}`);
    process.exit(1);
  }
  const manifest = parsed as RoutesManifest;

  // Discover all app routes.
  const localeFiles = walkFiles(APP_LOCALE_ROOT, (n) => n === 'page.tsx' || n === 'page.mdx');
  const apiFiles = walkFiles(APP_API_ROOT, (n) => n === 'route.ts');
  const discoveredRoutes: string[] = [];
  for (const abs of localeFiles) {
    const route = appRouteFromFile(abs, APP_LOCALE_ROOT, '');
    if (route) discoveredRoutes.push(route);
  }
  for (const abs of apiFiles) {
    const route = appRouteFromFile(abs, APP_API_ROOT, '/api');
    if (route) discoveredRoutes.push(route);
  }
  discoveredRoutes.sort();

  // Build manifest pattern matchers.
  const patterns = manifest.routes.map((r) => ({
    raw: r.path,
    regex: routePatternToRegex(r.path),
    entry: r,
  }));

  const uncovered: string[] = [];
  for (const route of discoveredRoutes) {
    if (SKIP_PATTERNS.some((p) => p.test(route))) continue;
    const match = patterns.find((p) => p.regex.test(route));
    if (!match) uncovered.push(route);
  }

  // Source-resolution check: every manifest entry with a `source` must
  // point at a file that exists. Globs like `**/page.tsx` are exempt
  // (they're documentation, not file pointers).
  const unresolved: { path: string; source: string }[] = [];
  for (const r of manifest.routes) {
    if (!r.source) continue;
    if (r.source.includes('**')) continue;
    const abs = resolve(REPO_ROOT, r.source);
    if (!existsSync(abs)) {
      unresolved.push({ path: r.path, source: r.source });
    }
  }

  // Report.
  console.log('# Route coverage report (aster-cloud)\n');
  console.log(`- discovered app routes: ${discoveredRoutes.length}`);
  console.log(`- manifest entries: ${manifest.routes.length}`);
  console.log(`- uncovered routes: ${uncovered.length}`);
  console.log(`- unresolved sources: ${unresolved.length}\n`);

  if (uncovered.length > 0) {
    console.log('## Routes in src/app/ with no manifest entry\n');
    console.log('Add one of these to `config/routes.yaml` (or extend SKIP_PATTERNS in check-route-coverage.ts if the route is internal):\n');
    for (const route of uncovered) console.log(`  - ${route}`);
    console.log('');
  }

  if (unresolved.length > 0) {
    console.log('## Manifest entries with missing source files\n');
    console.log('Either remove the `source:` line or fix the path:\n');
    for (const u of unresolved) console.log(`  - ${u.path} → ${u.source}`);
    console.log('');
  }

  if (uncovered.length > 0 || unresolved.length > 0) {
    process.exit(1);
  }
  console.log('OK');
}

main();
