import { describe, expect, it } from 'vitest';
import { inferParameterStructs, inferredFieldDefault } from './infer-parameter-structs';

describe('inferParameterStructs', () => {
  it('infers an untyped parameter from the matching Define and creates neutral sample defaults', () => {
    const parameters = [{ name: 'applicant', type: 'Text', typeKind: 'unknown' as const, optional: false, position: 0 }];
    const result = inferParameterStructs(parameters, 'Define Applicant has id, creditScore as Int, active as Bool.');
    expect(result[0]).toMatchObject({ type: 'Applicant', typeKind: 'struct' });
    expect(result[0].fields?.map((field) => field.name)).toEqual(['id', 'creditScore', 'active']);
    expect(result[0].fields?.map(inferredFieldDefault)).toEqual(['', 0, false]);
  });
});
