/**
 * source envelope（ADR 0051 §7）：5 段分帧 SHA-256 与 cloud 工具链身份串。
 *
 * envelope-vectors.json 是 aster-lang-test 共享向量的逐字节副本（aster-api 同一份），
 * 用 sha256 钉住副本本身，防止本地改动向量让两侧各自「通过」。
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdentifierKind, buildVocabularyScopes, canonicalScopesJson } from '@aster-cloud/aster-lang-ts/browser';
import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { cloudToolchainId, computeSourceEnvelope, vocabularyScopesJson } from '@/lib/policy-alias';

interface EnvelopeVector {
  content: string;
  aliasSetJson: string;
  locale: string;
  toolchainId: string;
  vocabulary: DomainVocabulary | null;
  scopesJson: string;
  expectedSha256: string;
}

const VECTORS_PATH = join(__dirname, '..', '..', 'lib', '__fixtures__', 'envelope-vectors.json');
const VECTORS_SHA256 = 'cc743299e6f0bde27b650337f0ebb70652b9b8c80ed6278d764b8c1416b8c563';
const raw = readFileSync(VECTORS_PATH);
const vectors = JSON.parse(raw.toString('utf8')) as EnvelopeVector[];

const EMPTY_VOCABULARY: DomainVocabulary = {
  id: 'empty',
  name: 'empty',
  locale: 'de-DE',
  version: '1.0.0',
  structs: [],
  fields: [],
  functions: [],
  enumValues: [],
};

describe('共享 envelope 向量', () => {
  it('副本与 aster-lang-test 原件逐字节一致（sha256 钉住）', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTORS_SHA256);
    expect(vectors.length).toBeGreaterThanOrEqual(3);
  });

  it.each(vectors.map((v, i) => [i, v] as const))('向量 %i：5 段 envelope 等于期望哈希', (_i, v) => {
    expect(computeSourceEnvelope(v.content, v.aliasSetJson, v.locale, v.toolchainId, v.scopesJson)).toBe(
      v.expectedSha256,
    );
  });

  it.each(vectors.map((v, i) => [i, v] as const))('向量 %i：scopesJson 由词汇推导', (_i, v) => {
    const expected = v.vocabulary === null ? '' : canonicalScopesJson(buildVocabularyScopes(v.vocabulary));
    expect(expected).toBe(v.scopesJson);
    expect(vocabularyScopesJson(v.vocabulary)).toBe(v.scopesJson);
  });
});

describe('computeSourceEnvelope', () => {
  it('第 5 段参与哈希：词汇段不同则 envelope 不同', () => {
    expect(computeSourceEnvelope('c', null, 'en-US', 't', '')).not.toBe(
      computeSourceEnvelope('c', null, 'en-US', 't', '{"x":1}'),
    );
  });

  it('无词汇时第 5 段为空串帧 0:|', () => {
    const expected = createHash('sha256').update('1:c|0:|5:en-US|1:t|0:|', 'utf8').digest('hex');
    expect(computeSourceEnvelope('c', null, 'en-US', 't', '')).toBe(expected);
    expect(computeSourceEnvelope('c', null, 'en-US', 't', null)).toBe(expected);
  });
});

describe('vocabularyScopesJson', () => {
  it('无词汇或词汇没有任何条目时为空串', () => {
    expect(vocabularyScopesJson(null)).toBe('');
    expect(vocabularyScopesJson(undefined)).toBe('');
    expect(vocabularyScopesJson(EMPTY_VOCABULARY)).toBe('');
  });

  it('只含字面量宏的词汇也输出完整规范 JSON（宏改变编译输入）', () => {
    const literalOnly: DomainVocabulary = {
      ...EMPTY_VOCABULARY,
      literals: [{ canonical: 'true', localized: 'jawohl', kind: IdentifierKind.LITERAL }],
    };
    const json = vocabularyScopesJson(literalOnly);
    expect(json).toBe(canonicalScopesJson(buildVocabularyScopes(literalOnly)));
    expect(json).toContain('"schemaVersion":1');
  });
});

describe('cloudToolchainId', () => {
  it('含 ABI 1.1、resolver 与 casefold 分量', () => {
    expect(cloudToolchainId()).toMatch(
      /^abi=1\.1;core=ts;validator=[^;]+;resolver=1;casefold=15\.1;build=[^;]+$/,
    );
  });
});
