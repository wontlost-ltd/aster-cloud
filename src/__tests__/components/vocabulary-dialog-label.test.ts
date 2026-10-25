import { describe, expect, it } from 'vitest';
import { withoutOptionalSuffix } from '@/app/[locale]/(dashboard)/domain-vocabularies/vocabulary-dialog';

// #590：kind=field 时 Parent struct 必填，标签去掉「optional」括注
describe('withoutOptionalSuffix', () => {
  it.each([
    ['Parent struct (optional)', 'Parent struct'],
    ['父结构（可选）', '父结构'],
    ['Übergeordnetes Struct (optional)', 'Übergeordnetes Struct'],
    ['Parent struct', 'Parent struct'],
  ])('%s → %s', (input, expected) => {
    expect(withoutOptionalSuffix(input)).toBe(expected);
  });
});
