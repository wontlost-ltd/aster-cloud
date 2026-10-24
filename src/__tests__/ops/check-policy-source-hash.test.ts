import { describe, expect, it } from 'vitest';
import { diffSourceHashes } from '../../../scripts/ops/source-hash-diff';

describe('diffSourceHashes', () => {
  it('reports cloud-only, hash mismatch, and api-only versions', () => {
    expect(diffSourceHashes(
      [{ id: 1, sourceHash: 'same' }, { id: 2, sourceHash: 'old' }, { id: 4, sourceHash: 'cloud' }],
      [{ id: 1, sourceHash: 'same' }, { id: 2, sourceHash: 'new' }, { id: 3, sourceHash: 'orphan' }],
    )).toEqual([
      { type: 'api_missing_cloud', id: '3', apiSourceHash: 'orphan' },
      { type: 'cloud_missing_api', id: '4', cloudSourceHash: 'cloud' },
      { type: 'hash_mismatch', id: '2', cloudSourceHash: 'old', apiSourceHash: 'new' },
    ]);
  });

  it('reports a cloud version missing from api', () => {
    expect(diffSourceHashes([{ id: '9', sourceHash: 'abc' }], [])).toEqual([
      { type: 'cloud_missing_api', id: '9', cloudSourceHash: 'abc' },
    ]);
  });

  it('returns no differences when all hashes match', () => {
    expect(diffSourceHashes([{ id: 1, sourceHash: 'abc' }], [{ id: '1', sourceHash: 'abc' }])).toEqual([]);
  });
});
