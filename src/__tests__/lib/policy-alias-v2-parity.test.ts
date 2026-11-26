/**
 * 别名规则 v2（ADR 0060 §5 / 计划 T12）：cloud `validateUserAliases` 与 core `UserAliasValidator`、ts `validateAliasSet`
 * 读同一份共享夹具 `alias_validation_v2_parity.json`，逐条得到相同的合法性与问题码集合。
 *
 * - 夹具是 core `src/test/resources/diagnostics/` 与 ts `shared/` 的逐字节副本，sha256 钉住，防止本地改动让三侧各自「通过」；
 * - `cases` 跑 cloud 校验器；`guardCases` 是完整编译的名字守卫，由引擎负责，这里用随包引擎整组重跑，确认依赖已含守卫；
 * - 占用集与服务端保存同源：`buildAliasReservedFromVocabulary(locale, 夹具词汇)`（含字面量触发词）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/prisma', () => ({ structuralAliasGrants: {} }));
vi.mock('@/db/fresh-read', () => ({ freshDb: {} }));

import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { CompileFailure, TS_VERSION, compileSourcePositionFreeSha256 } from '@aster-cloud/aster-lang-ts/package-check';
import {
  OPERATOR_KINDS,
  STRUCTURAL_KINDS,
  USER_ALIAS_VALIDATOR_VERSION,
  canonicalAliasJson,
  isHanSingleToken,
  validateUserAliases,
  type AliasSet,
} from '@/lib/policy-alias-shared';
import { cloudToolchainId } from '@/lib/policy-alias';
import { buildAliasReservedFromVocabulary } from '@/lib/structural-alias-grants';
import { ALL_ALIAS_KINDS } from '@/components/policy/policy-alias-types';

interface ParityCase {
  id: string;
  locale: string;
  allowStructural: boolean;
  aliasSet: AliasSet;
  vocabulary: DomainVocabulary | null;
  valid: boolean;
  codes: string[];
}

const FIXTURE_PATH = join(__dirname, '..', '..', 'lib', '__fixtures__', 'alias_validation_v2_parity.json');
/** 与 core / ts 两份副本相同的 sha256（ts v3.5.0–v3.7.0 `shared/`、core v1.0.52 `src/test/resources/diagnostics/`）。 */
const FIXTURE_SHA256 = '721ab90b1f847ce7e3806d32360db1157d6a1ac5368ef5d15f99e402464765c4';
const raw = readFileSync(FIXTURE_PATH);
interface GuardCase {
  id: string;
  locale: string;
  allowStructural: boolean;
  aliasSet: AliasSet;
  vocabulary: DomainVocabulary | null;
  source: string;
  expect: 'ok' | 'alias_identifier_collision' | 'parse_error';
}

/** CompileFailure 的诊断是 JSON 串；取去重排序后的 code 集合（无 code 或非 JSON 记为 text），与 ts 夹具测试同口径。 */
function diagnosticCodes(failure: CompileFailure): string[] {
  const codes = failure.diagnostics.map((d) => {
    try {
      return String((JSON.parse(d) as { code?: unknown }).code ?? 'text');
    } catch {
      return 'text';
    }
  });
  return [...new Set(codes)].sort();
}
const fixture = JSON.parse(raw.toString('utf8')) as { version: number; cases: ParityCase[]; guardCases: GuardCase[] };

describe('alias rule v2 parity (ADR 0060 §5.4)', () => {
  it('fixture is byte-identical to the core and ts copies', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(FIXTURE_SHA256);
    expect(fixture.version).toBe(2);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(16);
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const reserved = buildAliasReservedFromVocabulary(c.locale, c.vocabulary);
    const result = validateUserAliases(c.aliasSet, reserved, { allowStructural: c.allowStructural, locale: c.locale });
    expect(result.valid).toBe(c.valid);
    expect([...new Set(result.issues.map((issue) => issue.code))].sort()).toEqual([...c.codes].sort());
  });

  it('toolchainId contains validator=2', () => {
    expect(USER_ALIAS_VALIDATOR_VERSION).toBe('2');
    expect(cloudToolchainId()).toContain(';validator=2;');
  });
});

describe('isHanSingleToken', () => {
  it('counts code points, not UTF-16 units, and rejects Extension B', () => {
    // 两个扩展 B 汉字：4 个 UTF-16 单元、2 个码点，但不在允许区内
    expect(isHanSingleToken('𠀀𠀁', 'zh-CN')).toBe(false);
    expect(isHanSingleToken('一二三四五六七八', 'zh-CN')).toBe(true);
    expect(isHanSingleToken('一二三四五六七八九', 'zh-CN')).toBe(false);
    expect(isHanSingleToken('头', 'zh-CN')).toBe(false);
  });

  it('only applies to zh locales and treats a missing locale as non-zh', () => {
    expect(isHanSingleToken('低头', 'zh')).toBe(true);
    expect(isHanSingleToken('低头', 'zh_TW')).toBe(true);
    expect(isHanSingleToken('低头', 'en-US')).toBe(false);
    expect(isHanSingleToken('低头', null)).toBe(false);
    expect(validateUserAliases({ RETURN: ['低头'] }, new Set<string>(), { allowStructural: true }).issues)
      .toEqual([{ code: 'singleWord', kind: 'RETURN', alias: '低头' }]);
  });

  it('singleWord message names the v2 rule', () => {
    const result = validateUserAliases({ RETURN: ['头'] }, new Set<string>(), { allowStructural: true, locale: 'zh-CN' });
    expect(result.errors).toEqual([
      "别名 '头'（RETURN）必须是多词短语，或 zh 下 2–8 个汉字的单词；其余单词别名会占用标识符命名空间，破坏用户空间",
    ]);
  });
});

describe('FUNC_PRODUCE is a structural kind (ADR 0060 §5.1)', () => {
  it('needs the grant and is offered in the alias panel', () => {
    expect(STRUCTURAL_KINDS.has('FUNC_PRODUCE')).toBe(true);
    const ungranted = validateUserAliases({ FUNC_PRODUCE: ['yield up'] }, new Set<string>());
    expect(ungranted.issues).toEqual([{ code: 'structuralNotGranted', kind: 'FUNC_PRODUCE' }]);
    expect(validateUserAliases({ FUNC_PRODUCE: ['yield up'] }, new Set<string>(), { allowStructural: true }).valid).toBe(true);
    // 面板列出的 kind 与两档白名单完全一致：每个可别名 kind 都能在界面里编辑，界面也不列白名单以外的 kind
    expect(new Set(ALL_ALIAS_KINDS.map((meta) => meta.kind))).toEqual(new Set([...OPERATOR_KINDS, ...STRUCTURAL_KINDS]));
  });
});

/**
 * 随包引擎（Node 包导出前 Worker 内重编译所用的同一份 aster-lang-ts）已是 v2：
 * 3.4.0 会以「必须是多词短语」拒绝这组汉字单词别名，导出时报 E739。
 */
describe('bundled aster-lang-ts recompiles the poem with v2 aliases', () => {
  const SOURCE = '床前 明月光。\n疑是 地上霜，举头 望明月：\n  低头 思故乡。\n';
  const ALIASES = { FUNC_PRODUCE: ['举头'], FUNC_TO: ['疑是'], MODULE_DECL: ['床前'], RETURN: ['低头'] };
  const VOCAB: DomainVocabulary = {
    id: 'policy.embedded', name: 'policy', locale: 'zh-CN', version: '1',
    structs: [{ localized: '望明月', canonical: 'Text', kind: 'struct' } as DomainVocabulary['structs'][number]],
    fields: [], functions: [], enumValues: [],
    literals: [{ localized: '思故乡', canonical: '静夜思', kind: 'literal' } as NonNullable<DomainVocabulary['literals']>[number]],
  };
  /** ts v3.5.0 `jingyesi-policy.test.ts` 的 JINGYESI_POSITION_FREE_SHA256（aster-api Java 侧证明用同一值）。 */
  const JINGYESI_POSITION_FREE_SHA256 = '55512170231ae56d7f01b8130ce368d650c5b390ad6f0ac7f34d5350c8960ec6';
  const opts = (aliasSet: AliasSet, allowStructural = true) => ({
    locale: 'zh-CN',
    aliasSetJson: canonicalAliasJson(aliasSet) ?? 'null',
    allowStructural,
    vocabularyJson: JSON.stringify(VOCAB),
  });

  it('pins ts 3.8.0', () => {
    expect(TS_VERSION).toBe('3.8.0');
  });

  it('compiles to the same Core IR as the ts engine proof', () => {
    expect(compileSourcePositionFreeSha256(SOURCE, opts(ALIASES))).toBe(JINGYESI_POSITION_FREE_SHA256);
  });

  it('rejects the poem without the structural grant', () => {
    expect(() => compileSourcePositionFreeSha256(SOURCE, opts(ALIASES, false))).toThrow(CompileFailure);
  });

  // 夹具的 guardCases（名字守卫的位置 × kind 矩阵）由引擎负责；这里用随包引擎整组重跑，确认 cloud 依赖的就是带守卫的版本。
  it.each(fixture.guardCases.map((g) => [g.id, g] as const))('guard %s', (_id, g) => {
    let failure: CompileFailure | undefined;
    try {
      compileSourcePositionFreeSha256(g.source, {
        locale: g.locale,
        aliasSetJson: canonicalAliasJson(g.aliasSet) ?? 'null',
        allowStructural: g.allowStructural,
        ...(g.vocabulary ? { vocabularyJson: JSON.stringify(g.vocabulary) } : {}),
      });
    } catch (err) {
      if (!(err instanceof CompileFailure)) throw err;
      failure = err;
    }
    if (g.expect === 'ok') {
      expect(failure?.diagnostics).toBeUndefined();
    } else if (g.expect === 'alias_identifier_collision') {
      // alias_identifier_collision 登记为 E808（ADR 0031；ts shared/error_codes.json 与 core ErrorCode 同号）
      expect(failure && diagnosticCodes(failure)).toEqual(['E808']);
    } else {
      expect(failure).toBeDefined();
      expect(diagnosticCodes(failure!)).not.toContain('E808');
    }
  });
});
