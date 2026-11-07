/**
 * Snippet template *engine* contract.
 *
 * The sibling `snippet-templates.test.ts` checks structural invariants
 * (id format, Module/Rule presence, page-action coverage). It does NOT
 * compile the CNL, which is how a batch of templates using `has` as an
 * infix operator — and two using `not equal to`, which lowers to a `!=`
 * call the interpreter can't resolve — once shipped: every one of them
 * satisfied the structural checks while being un-runnable in the editor.
 *
 * A template that doesn't compile (or compiles but throws at eval) is a
 * dead Open-in-Playground button: the user clicks "Try it", the editor
 * loads, and the first thing they see is an error on canonical example
 * code. That is the worst possible first impression for an adoption
 * funnel, so this test makes it a hard CI failure.
 *
 * It uses the *real* vendored engine (no `vi.mock`) — the same
 * `@aster-cloud/aster-lang-ts/browser` build production loads — so a
 * template only passes here if it would actually run for a user.
 */

import { describe, it, expect } from 'vitest';
import { compile, evaluate } from '@aster-cloud/aster-lang-ts/browser';
import { listSnippetTemplates } from '@/lib/playground/snippet-templates';

// Types derived from the engine functions themselves. The Core IR type
// namespace isn't exposed on a public subpath (only the builder const
// is), so we reconstruct exactly what we touch from `compile`'s return
// shape — which keeps this test resilient to internal type moves.
type CoreModule = NonNullable<ReturnType<typeof compile>['core']>;
type CoreDecl = CoreModule['decls'][number];
type CoreFunc = Extract<CoreDecl, { kind: 'Func' }>;

/**
 * A representative input for a parameter, chosen by name. Templates
 * compare parameters against string literals or numeric thresholds; the
 * concrete value is irrelevant to the contract (we assert the body runs
 * without throwing, not a particular verdict), so a type-appropriate
 * zero value is enough to exercise every branch's evaluation path.
 */
function representativeArg(paramName: string): unknown {
  return /amount|count|score|income|age|num|qty|size|limit/i.test(paramName)
    ? 0
    : '';
}

/** Narrow a Core declaration to the evaluable `Func` variant. */
function isFunc(decl: CoreDecl | undefined): decl is CoreFunc {
  return decl?.kind === 'Func';
}

describe('snippet template engine contract', () => {
  const templates = listSnippetTemplates();

  it.each(templates.map((t) => [t.id, t.source] as const))(
    'template %s compiles and evaluates without throwing',
    (id, source) => {
      const result = compile(source);
      expect(
        result.success,
        `template "${id}" failed to compile: ${JSON.stringify(
          result.parseErrors ?? result.loweringDiagnostics ?? result,
        )}`,
      ).toBe(true);

      const core = result.core;
      expect(core, `template "${id}" compiled with no Core IR`).toBeDefined();
      if (!core) return;

      const decl = core.decls[0];
      expect(
        isFunc(decl),
        `template "${id}" has no evaluable Rule as its first declaration`,
      ).toBe(true);
      if (!isFunc(decl)) return;

      const context = Object.fromEntries(
        decl.params.map((p) => [p.name, representativeArg(p.name)]),
      );

      // Evaluation must not throw and must not report failure. We do not
      // assert a specific value — the inputs are deliberately neutral —
      // only that the lowered expression is fully resolvable by the
      // interpreter (this is what catches operator-resolution gaps like
      // the `!=` / `not equal to` divergence).
      const evalResult = evaluate(core, decl.name, context);
      expect(
        evalResult.success,
        `template "${id}" evaluated to a failure: ${evalResult.error ?? ''}`,
      ).toBe(true);
    },
  );
});
