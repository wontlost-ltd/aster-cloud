/**
 * Golden / stability tests for vocabulary serialization (B15).
 *
 * The dedup key and snapshot contentHash both rely on canonical JSON
 * serialization being deterministic across row orderings and field-key
 * orderings. These tests freeze that contract so refactors of
 * assembleDomainVocabularyFromLinks / computeDedupKey will fail loudly
 * if they change the wire format.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assembleDomainVocabularyFromLinks,
  computeDedupKey,
  normalizeTermInput,
} from '@/lib/domain-vocabulary-validation';

function termIdsHash(ids: readonly string[]): string {
  // Snapshot contentHash sorts the termIds and serializes them via the same
  // canonical-JSON shape the service code uses.
  const sorted = [...ids].sort();
  const canonical = JSON.stringify(sorted);
  return createHash('sha256').update(canonical).digest('hex');
}

describe('vocabulary golden serialization', () => {
  it('computeDedupKey produces the recorded golden hash for the canonical Loan term', () => {
    const normalized = normalizeTermInput({
      domain: 'finance.loan',
      locale: 'en-US',
      kind: 'struct',
      canonical: 'Loan',
      localized: 'Loan',
    });
    const key = computeDedupKey(normalized);
    // Recorded once at the time of B15; future changes to the canonical
    // representation must update this golden value intentionally.
    // ADR 0051：localizedNorm 改为 NFC 精确写法（不再小写），golden 随之更新。
    expect(key).toBe(
      'c3caaa67273f98222c203a53f62f27d6b3018e2880402dbfbac8f43a78d0e549',
    );
  });

  it('computeDedupKey is independent of insertion order of unrelated fields', () => {
    const a = normalizeTermInput({
      domain: 'finance.loan',
      locale: 'en-US',
      kind: 'field',
      canonical: 'principal',
      localized: 'principal amount',
      parentCanonical: 'Loan',
      description: 'amount borrowed',
      aliases: ['amount'],
    });
    const b = normalizeTermInput({
      // Same content, but the input keys are reordered to verify the
      // serialization does not depend on JS object iteration order.
      aliases: ['amount'],
      description: 'amount borrowed',
      parentCanonical: 'Loan',
      localized: 'principal amount',
      canonical: 'principal',
      kind: 'field',
      locale: 'en-US',
      domain: 'finance.loan',
    });
    expect(computeDedupKey(a)).toBe(computeDedupKey(b));
  });

  it('assembleDomainVocabularyFromLinks produces a stable shape independent of row order', () => {
    const rows = [
      {
        domainTermId: 't1',
        domain: 'finance.loan',
        locale: 'en-US',
        kind: 'struct',
        canonical: 'Loan',
        localized: 'Loan',
      },
      {
        domainTermId: 't2',
        domain: 'finance.loan',
        locale: 'en-US',
        kind: 'field',
        canonical: 'principal',
        localized: 'principal',
        parentCanonical: 'Loan',
      },
    ] as const;
    const v1 = assembleDomainVocabularyFromLinks(rows, {
      domain: 'finance.loan',
      locale: 'en-US',
    });
    const v2 = assembleDomainVocabularyFromLinks([rows[1], rows[0]], {
      domain: 'finance.loan',
      locale: 'en-US',
    });
    // Insertion order within a kind group is preserved (struct, field), so
    // reversing rows that fall into different groups produces an identical
    // shape because each group is built independently. We canonicalize by
    // sorting the kind buckets before hashing.
    const canonicalize = (v: ReturnType<typeof assembleDomainVocabularyFromLinks>) => ({
      ...v,
      structs: [...v.structs].sort((a, b) => a.canonical.localeCompare(b.canonical)),
      fields: [...v.fields].sort((a, b) => a.canonical.localeCompare(b.canonical)),
      functions: [...v.functions].sort((a, b) => a.canonical.localeCompare(b.canonical)),
      enumValues: [...(v.enumValues ?? [])].sort((a, b) =>
        a.canonical.localeCompare(b.canonical),
      ),
    });
    expect(canonicalize(v1)).toEqual(canonicalize(v2));
  });

  it('snapshot contentHash is invariant under termId order', () => {
    const a = termIdsHash(['t1', 't2', 't3']);
    const b = termIdsHash(['t3', 't1', 't2']);
    expect(a).toBe(b);
  });

  it('snapshot contentHash differs when a termId changes', () => {
    expect(termIdsHash(['t1', 't2'])).not.toBe(termIdsHash(['t1', 't3']));
  });
});
