// @vitest-environment node
// Node 策略包导出前的 Worker 内复核（ADR 0059 P2 T27，修订 3 P2-R5 / P2-R13）：真实的 aster-lang-ts `./package-check`，
// 不 mock 编译器与解释器。平台 prepare 结果用 ts 编译同一源码模拟（两引擎一致时即平台 IR）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '@aster-cloud/aster-lang-ts/browser';
import { TS_VERSION, compileSourcePositionFreeSha256 } from '@aster-cloud/aster-lang-ts/package-check';
import { NODE_CHECK_LIMITS, runNodeCheck, type NodeCheckCompileInput } from '@/lib/package-node-check';
import { nodePackageRuntime } from '@/lib/package-node-runtime';
import type { PackageExportPrepareResponse } from '@/services/policy/policy-api';

const source = 'Module demo.pricing.\n\nRule scale given amount as Long, produce Long:\n  Return amount plus 2.\n';
const input: NodeCheckCompileInput = { source, locale: 'en-US', aliasSet: null };

function platformCoreIr(src: string): string {
  const r = compile(src);
  if (!r.success || !r.coreJson) throw new Error('fixture source must compile');
  return r.coreJson;
}

const probe = (amount: string | number, value: string) =>
  `{"entry":"scale","expected":{"ok":true,"value":${value}},"input":{"amount":${JSON.stringify(amount)}}}`;
// 第二条的期望 2⁵³+1 超出 JS number 精度：probesJson 必须是保留数字原文的文本
const probesJson = `{"probes":[${probe(1, '3')},${probe('9007199254740991', '9007199254740993')}]}`;

function prepared(over: Partial<PackageExportPrepareResponse> = {}): PackageExportPrepareResponse {
  return {
    exportable: true,
    diagnostics: [],
    entry: 'scale',
    coreIr: platformCoreIr(source),
    coreIrSha256: 'aa'.repeat(32),
    positionFreeSha256: compileSourcePositionFreeSha256(source, { locale: 'en-US', aliasSetJson: 'null', allowStructural: false }),
    probes: null,
    probesJson,
    probesSha256: 'bb'.repeat(32),
    probeCount: 2,
    runtime: { cliName: '@aster-cloud/aster-lang-ts', cliVersion: TS_VERSION, ecosystem: '1.0.51' },
    ...over,
  };
}

describe('runNodeCheck', () => {
  it('上限取修订 3 P2-R13 与裁决值：每条 5M 步、合计 60M、深度 10 000、墙钟 20 s', () => {
    expect(NODE_CHECK_LIMITS).toEqual({ maxSteps: 5_000_000, maxCallDepth: 10_000, deadlineMs: 20_000, maxTotalSteps: 60_000_000 });
  });

  it('全部一致：nodeProbes 四个字段取平台 probesSha256、探针数与本地 ts 版本', () => {
    expect(runNodeCheck(prepared(), input)).toEqual({
      ok: true,
      nodeProbes: { probesSha256: 'bb'.repeat(32), count: 2, agreed: 2, tsVersion: TS_VERSION },
      layoutOk: true,
    });
  });

  it('本地 ts 版本 ≠ 锁文件 node.cliVersion → skew，不编译不跑探针', () => {
    expect(runNodeCheck(prepared(), input, undefined, '3.2.0')).toEqual({ ok: false, skew: true });
    // 锁文件领先本地 ts 一个 minor（由 TS_VERSION 推出，ts 升级后用例不随之失效）
    const [major, minor] = TS_VERSION.split('.').map(Number);
    const lockAhead = prepared({ runtime: { cliName: '@aster-cloud/aster-lang-ts', cliVersion: `${major}.${minor + 1}.0`, ecosystem: '1.0.51' } });
    expect(runNodeCheck(lockAhead, input)).toEqual({ ok: false, skew: true });
  });

  it('E739：篡改编译输入的 locale（zh-CN 源码按 en-US 重编译失败），不跑探针', () => {
    const zh = '模块 演示.定价。\n\n规则 问候 给定 名字 作为 文本 产出 文本：\n  返回 名字。\n';
    const zhHash = compileSourcePositionFreeSha256(zh, { locale: 'zh-CN', aliasSetJson: 'null', allowStructural: false });
    const zhPrepared = prepared({ entry: '问候', positionFreeSha256: zhHash, probesJson: 'not json' });
    // 未篡改时投影哈希一致，才会去读探针（这里探针文本非法，读到即抛错）
    expect(() => runNodeCheck(zhPrepared, { source: zh, locale: 'zh-CN', aliasSet: null })).toThrow();
    const r = runNodeCheck(zhPrepared, { source: zh, locale: 'en-US', aliasSet: null });
    expect(r.ok).toBe(false);
    const d = 'diagnostics' in r ? r.diagnostics : [];
    expect(d).toEqual([{
      severity: 'error',
      code: 'E739',
      message: `Node recompilation of the policy differs from the platform Core IR (positionFreeSha256 ${zhHash} vs compile-failed)`,
      startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
    }]);
  });

  it('E739：ts 编译成功但投影不同（平台哈希被篡改）', () => {
    const r = runNodeCheck(prepared({ positionFreeSha256: 'cc'.repeat(32) }), input);
    const d = 'diagnostics' in r ? r.diagnostics : [];
    expect(d[0].code).toBe('E739');
    expect(d[0].message).toContain(`positionFreeSha256 ${'cc'.repeat(32)} vs ${prepared().positionFreeSha256}`);
  });

  it('E735：篡改一条期望，message 给出探针下标（0 起）、期望与实际', () => {
    const tampered = `{"probes":[${probe(1, '3')},${probe(5, '8')}]}`;
    const r = runNodeCheck(prepared({ probesJson: tampered }), input);
    const d = 'diagnostics' in r ? r.diagnostics : [];
    expect(d).toEqual([{
      severity: 'error',
      code: 'E735',
      message: 'Node probe 1 disagrees with the platform: expected {"ok":true,"value":8}, got {"ok":true,"value":7}',
      startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
    }]);
  });

  it('E735：期望 / 实际文本中的 `{actual}`、`$&` 原样写入 message，不被再次替换', () => {
    const greet = 'Module demo.greet.\n\nRule echo given name as Text, produce Text:\n  Return name.\n';
    const r = runNodeCheck(prepared({
      entry: 'echo',
      coreIr: platformCoreIr(greet),
      positionFreeSha256: compileSourcePositionFreeSha256(greet, { locale: 'en-US', aliasSetJson: 'null', allowStructural: false }),
      probesJson: '{"probes":[{"entry":"echo","expected":{"ok":true,"value":"{actual} $&"},"input":{"name":"x"}}]}',
    }), { ...input, source: greet });
    expect('diagnostics' in r && r.diagnostics[0].message).toBe(
      'Node probe 0 disagrees with the platform: expected {"ok":true,"value":"{actual} $&"}, got {"ok":true,"value":"x"}');
  });

  it('E735：期望值经 JS number 往返（丢精度）即不一致——必须用保留原文的 probesJson', () => {
    const lossy = JSON.stringify(JSON.parse(probesJson));
    const r = runNodeCheck(prepared({ probesJson: lossy }), input);
    expect('diagnostics' in r && r.diagnostics[0].code).toBe('E735');
  });

  it('E735：超出调用深度按不一致处理，不挂住、不降级', () => {
    const deep = 'Module demo.loop.\n\nRule spin given n as Int, produce Int:\n  If n less than 1:\n    Return 0.\n  Return spin(n minus 1).\n';
    const r = runNodeCheck(prepared({
      entry: 'spin',
      coreIr: platformCoreIr(deep),
      positionFreeSha256: compileSourcePositionFreeSha256(deep, { locale: 'en-US', aliasSetJson: 'null', allowStructural: false }),
      probesJson: '{"probes":[{"entry":"spin","expected":{"ok":true,"value":0},"input":{"n":20000}}]}',
    }), { ...input, source: deep });
    expect('diagnostics' in r && r.diagnostics[0].code).toBe('E735');
  });

  it('探针入口不是本次导出的入口 → 不一致（与 CLI verify --probes 同一入口校验）', () => {
    const other = '{"probes":[{"entry":"other","expected":{"ok":true,"value":0},"input":{}}]}';
    const r = runNodeCheck(prepared({ probesJson: other }), input);
    expect('diagnostics' in r && r.diagnostics[0].code).toBe('E735');
  });

  it('prepare 结果缺比对必需字段 → 抛错（路由按上游错误处理，不导出）', () => {
    expect(() => runNodeCheck(prepared({ probesJson: null }), input)).toThrow(/missing fields/);
    expect(() => runNodeCheck(prepared({ runtime: null }), input)).toThrow(/missing fields/);
  });
});

describe('nodePackageRuntime', () => {
  it('版本即 ts 盖章版本，且等于 package.json 的精确 pin（未盖章的占位值不得进生产）', () => {
    const pin = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')).dependencies['@aster-cloud/aster-lang-ts'];
    expect(nodePackageRuntime()).toEqual({ tsVersion: TS_VERSION });
    expect(TS_VERSION).toBe(pin);
  });
});
