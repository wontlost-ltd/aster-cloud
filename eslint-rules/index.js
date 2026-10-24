/**
 * Local ESLint plugin: deployment-mode (legacy name — also hosts a few
 * project-wide custom rules outside the deployment-mode contract).
 *
 * Rules:
 *   - no-direct-macro: forbid direct __DEPLOYMENT_MODE__ /
 *     process.env.DEPLOYMENT_MODE access outside helper + hot-gate files.
 *   - require-license-write-gate: admin mutate routes must call
 *     requireLicenseWriteOk() or guard with !IS_SAAS (license-system-v2 PR-L11).
 *   - no-static-saas-only-import: forbid static value-import of
 *     stripe/resend/mixpanel-browser; must go through lib/* wrappers that
 *     dynamic-import behind __DEPLOYMENT_MODE__ guards. This is the
 *     Turbopack-compat replacement for webpack's resolve.alias = false.
 *   - no-cross-table-orderby: forbid `orderBy: <otherTable>.col` in
 *     `db.query.<rootTable>.findMany/findFirst` calls. Drizzle generates
 *     SQL that doesn't include the with-table in the root FROM, so the
 *     query throws at runtime. Source: commit c6f8f5a (api/teams 500).
 *
 * Wired into eslint.config.mjs as a plugin object (flat config).
 */

'use strict';

module.exports = {
  rules: {
    'no-direct-macro': require('./no-direct-macro'),
    'require-license-write-gate': require('./require-license-write-gate'),
    'no-static-saas-only-import': require('./no-static-saas-only-import'),
    'no-cross-table-orderby': require('./no-cross-table-orderby'),
    'no-stale-safe-column-read': require('./no-stale-safe-column-read'),
  },
};
