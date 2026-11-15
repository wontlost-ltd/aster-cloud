// @vitest-environment node
/**
 * Agent 绕过演示（aster-api#464 阶段 D，Task 13）的离线部分：不需要 aster-api。
 *
 *   - 演示策略在生产同款浏览器引擎里编译无错误：模块 demo.billing、入口 decide；
 *     refund_payment → DENY（带 @id DEMO-REFUND-001），其余动作 ALLOW。
 *   - 上游 upstream-billing.mjs 是真实 stdio MCP 服务器：每次被调用向 $DEMO_SIDE_EFFECTS 追加一行 JSON，
 *     演示据此判定「工具到底有没有执行」。
 *   - 对抗驱动拉起代理的参数：隔离方式、工具白名单、租户与策略地址都显式给出（代理模式必填项）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, evaluate, EN_US } from '@aster-cloud/aster-lang-ts/browser';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ATTEMPTS,
  DEMO_POLICY,
  DEMO_RULE_ID,
  POLICY_FILE,
  UPSTREAM_FILE,
  proxyArgs,
  readSideEffects,
} from '../../../scripts/agent-guard-demo/adversarial-agent';

const source = readFileSync(POLICY_FILE, 'utf8');

function guardRequest(action: string) {
  return {
    req: {
      principal_id: 'demo-agent',
      principal_type: 'agent',
      principal_roles: '',
      action,
      resource_type: '',
      resource_id: '',
      context: '',
      agent_model: 'scripted-adversary',
    },
  };
}

describe('演示策略 policy.aster', () => {
  const compiled = compile(source, { lexicon: EN_US } as Parameters<typeof compile>[1]);

  it('编译无错误，模块与入口与代理的 --policy 一致', () => {
    const errors = ((compiled as { diagnostics?: { severity?: string }[] }).diagnostics ?? []).filter(
      (d) => d.severity === 'error',
    );
    expect(errors).toEqual([]);
    expect(compiled.core?.name).toBe(DEMO_POLICY.split('/')[0]);
    expect(DEMO_POLICY).toBe('demo.billing/decide');
  });

  it('规则带 @id DEMO-REFUND-001', () => {
    expect(source).toContain(`@id("${DEMO_RULE_ID}")`);
  });

  it('refund_payment → DENY，lookup_payment → ALLOW', () => {
    const refund = evaluate(compiled.core!, 'decide', guardRequest('refund_payment'));
    const lookup = evaluate(compiled.core!, 'decide', guardRequest('lookup_payment'));
    expect(refund.success).toBe(true);
    expect((refund.value as { outcome?: string }).outcome).toBe('DENY');
    expect((lookup.value as { outcome?: string }).outcome).toBe('ALLOW');
  });
});

describe('对抗驱动', () => {
  it('三次尝试：直接退款 → 带 approved: true 重试 → 改调 lookup_payment', () => {
    expect(ATTEMPTS.map((a) => [a.tool, a.arguments.approved ?? null])).toEqual([
      ['refund_payment', null],
      ['refund_payment', true],
      ['lookup_payment', null],
    ]);
  });

  it('代理参数显式给出隔离方式、白名单、租户与策略地址', () => {
    const args = proxyArgs({ baseApi: 'http://localhost:18964', tenantId: 'team-x', policy: DEMO_POLICY });
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag('--isolation')).toBe('network');
    expect(flag('--tools')).toBe('refund_payment,lookup_payment');
    expect(flag('--tenant-id')).toBe('team-x');
    expect(flag('--policy')).toBe('demo.billing/decide');
    expect(flag('--base-url')).toBe('http://localhost:18964');
    expect(flag('--executor-id')).toBe('aster-guard-mcp@agent-guard-demo');
    expect(flag('--upstream')).toContain(UPSTREAM_FILE);
    // API key 只经环境变量传给代理，不出现在命令行
    expect(args.join(' ')).not.toMatch(/ak_/);
  });
});

describe('上游 upstream-billing.mjs', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('每次被调用向 $DEMO_SIDE_EFFECTS 追加一行', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agd-upstream-'));
    const file = join(dir, 'side-effects.jsonl');
    const client = new Client({ name: 'agd-upstream-test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [UPSTREAM_FILE],
        env: { ...getDefaultEnvironment(), DEMO_SIDE_EFFECTS: file },
        stderr: 'pipe',
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['lookup_payment', 'refund_payment']);
      expect(readSideEffects(file)).toEqual([]);
      await client.callTool({ name: 'lookup_payment', arguments: { paymentId: 'P-1001' } });
      await client.callTool({
        name: 'refund_payment',
        arguments: { paymentId: 'P-1001', amount: 5000, reason: 'r', approved: true },
      });
      const effects = readSideEffects(file);
      expect(effects.map((e) => e.tool)).toEqual(['lookup_payment', 'refund_payment']);
      expect(effects[1].args).toEqual({ paymentId: 'P-1001', amount: 5000, reason: 'r', approved: true });
    } finally {
      await client.close();
    }
  });
});
