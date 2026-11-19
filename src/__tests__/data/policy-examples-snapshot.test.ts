/**
 * #791 引入带别名 / 排版 / 能力要求的模板后，原有的六个普通模板必须原样不变：仍是只替换源码的模板
 * （无 aliasSet / layout / requires / cnlLocale），源码、元数据与示例输入逐字不变（哈希快照）。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { POLICY_EXAMPLES, hasTemplateExtras, isTemplateAvailable } from '@/data/policy-examples';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const CONTENT_ONLY = POLICY_EXAMPLES.filter((e) => e.category !== 'showcase');
const NO_CAPABILITIES = { structuredAuthoring: false, structuralAliases: false };

describe('existing content-only templates are unaffected', () => {
  it('stay content-only and available without any capability', () => {
    for (const e of CONTENT_ONLY) {
      expect(hasTemplateExtras(e), e.id).toBe(false);
      expect(e.requires, e.id).toBeUndefined();
      expect(e.cnlLocale, e.id).toBeUndefined();
      expect(isTemplateAvailable(e, NO_CAPABILITIES), e.id).toBe(true);
    }
  });

  it('keep their ids, order, sources, metadata and inputs', () => {
    expect(
      CONTENT_ONLY.map((e) => ({
        id: e.id,
        category: e.category,
        groupId: e.groupId,
        sources: sha(e.sources),
        metadata: sha(e.metadata),
        defaultInputs: sha(e.defaultInputs),
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "category": "starter",
          "defaultInputs": "2b3c79d29cf55396",
          "groupId": "loan",
          "id": "basic-starter",
          "metadata": "df8b1b961f35601c",
          "sources": "0c51278433ef0d4d",
        },
        {
          "category": "loan",
          "defaultInputs": "d8e1df6dbb0c7100",
          "groupId": "loan",
          "id": "loan-evaluation",
          "metadata": "b4a202590ef757d9",
          "sources": "5390e15d76d33740",
        },
        {
          "category": "healthcare",
          "defaultInputs": "d39896ac93828987",
          "groupId": "eligibility",
          "id": "healthcare-eligibility",
          "metadata": "9321f9c3ff4763bf",
          "sources": "4e3d0d37c5fd9656",
        },
        {
          "category": "auto-insurance",
          "defaultInputs": "84c4a7de69fe59c3",
          "groupId": "auto",
          "id": "auto-insurance-quote",
          "metadata": "5042cbc8700ff307",
          "sources": "9601e96971b740eb",
        },
        {
          "category": "fraud",
          "defaultInputs": "3b3ab3c2cac48cc5",
          "groupId": "fraud",
          "id": "fraud-detection",
          "metadata": "08fd145759b375a1",
          "sources": "34dcd41f38213d9b",
        },
        {
          "category": "creditcard",
          "defaultInputs": "1d5c906e5e83fdd8",
          "groupId": "creditcard",
          "id": "creditcard-application",
          "metadata": "bc245e4627a60872",
          "sources": "bd03181715c3dbdc",
        },
      ]
    `);
  });
});
