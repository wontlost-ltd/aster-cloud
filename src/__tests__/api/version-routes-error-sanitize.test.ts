// 版本操作与安全事件路由的失败响应（#662）。
//
// 已知业务错误（版本不存在、状态不允许、默认版本不能废弃/归档）带稳定 code 与人读 message 返回；
// 未识别的异常（数据库错误、内部路径等）只写服务端日志，响应是通用文案 + internal_error + requestId，
// 绝不回传原始 error.message。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/services/policy/version-manager', async () => {
  const actual = await vi.importActual<typeof import('@/services/policy/version-manager')>(
    '@/services/policy/version-manager',
  );
  return {
    archiveVersion: vi.fn(),
    deprecateVersion: vi.fn(),
    setDefaultVersion: vi.fn(),
    submitForApproval: vi.fn(),
    approveVersion: vi.fn(),
    getVersionDetail: vi.fn(),
    PolicyAccessDeniedError: actual.PolicyAccessDeniedError,
    SegregationOfDutiesError: actual.SegregationOfDutiesError,
    VocabularyFreezeError: actual.VocabularyFreezeError,
    VocabularyChangedSinceSaveError: actual.VocabularyChangedSinceSaveError,
  };
});
vi.mock('@/services/security/security-event-service', () => ({
  getSecurityEvents: vi.fn(),
  getSecurityEventStats: vi.fn(),
}));

import { auth } from '@/auth';
import {
  archiveVersion,
  deprecateVersion,
  setDefaultVersion,
  submitForApproval,
  approveVersion,
  getVersionDetail,
} from '@/services/policy/version-manager';
import { VersionStateError } from '@/services/policy/version-state-error';
import { getSecurityEvents, getSecurityEventStats } from '@/services/security/security-event-service';
import { POST as archivePOST } from '@/app/api/v1/policies/[id]/versions/[version]/archive/route';
import { POST as deprecatePOST } from '@/app/api/v1/policies/[id]/versions/[version]/deprecate/route';
import { POST as setDefaultPOST } from '@/app/api/v1/policies/[id]/versions/[version]/set-default/route';
import { POST as submitPOST } from '@/app/api/v1/policies/[id]/versions/[version]/submit/route';
import { POST as rejectPOST } from '@/app/api/v1/policies/[id]/versions/[version]/reject/route';
import { GET as detailGET } from '@/app/api/v1/policies/[id]/versions/[version]/route';
import { GET as eventsGET } from '@/app/api/v1/security/events/route';
import { GET as statsGET } from '@/app/api/v1/security/stats/route';
import type { NextRequest } from 'next/server';

const INTERNAL = 'relation "policy_versions" does not exist at /app/.next/server/chunks/123.js';
const params = { params: Promise.resolve({ id: 'p1', version: '3' }) };

function req(url: string, body?: unknown): NextRequest {
  return new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

const versionUrl = 'http://localhost/api/v1/policies/p1/versions/3';

// 每个版本操作路由：调用它、让它依赖的服务函数失败。
const actionCases = [
  { name: 'archive', mock: archiveVersion, call: () => archivePOST(req(`${versionUrl}/archive`, {}), params) },
  { name: 'deprecate', mock: deprecateVersion, call: () => deprecatePOST(req(`${versionUrl}/deprecate`, {}), params) },
  { name: 'set-default', mock: setDefaultVersion, call: () => setDefaultPOST(req(`${versionUrl}/set-default`, {}), params) },
  { name: 'submit', mock: submitForApproval, call: () => submitPOST(req(`${versionUrl}/submit`, {}), params) },
  { name: 'reject', mock: approveVersion, call: () => rejectPOST(req(`${versionUrl}/reject`, { comment: 'no' }), params) },
] as const;

describe('版本与安全路由：兜底分支不回传原始错误（#662）', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ user: { id: 'u1' } } as never);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  for (const c of actionCases) {
    it(`${c.name}：未识别异常 → 500 internal_error + requestId，正文不含原始消息，日志保留原始错误`, async () => {
      vi.mocked(c.mock).mockRejectedValue(new Error(INTERNAL));
      const res = await c.call();
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(text).not.toContain(INTERNAL);
      const body = JSON.parse(text);
      expect(body.error.code).toBe('internal_error');
      expect(typeof body.error.message).toBe('string');
      // 顶层也有人读 message（与 envelope 内相同），前端无论读哪一层都拿到字符串
      expect(body.message).toBe(body.error.message);
      expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
      expect(consoleError).toHaveBeenCalled();
      expect(JSON.stringify(consoleError.mock.calls)).toContain(body.error.requestId);
    });

    it(`${c.name}：版本状态错误 → 400，带稳定 code 与人读 message`, async () => {
      vi.mocked(c.mock).mockRejectedValue(
        new VersionStateError('default_version_locked', 'Version v3 is the default version.'),
      );
      const res = await c.call();
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('default_version_locked');
      expect(body.message).toBe('Version v3 is the default version.');
    });
  }

  it('版本详情：未识别异常 → 500 internal_error，不含原始消息', async () => {
    vi.mocked(getVersionDetail).mockRejectedValue(new Error(INTERNAL));
    const res = await detailGET(req(versionUrl), params);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain(INTERNAL);
    expect(JSON.parse(text).error.code).toBe('internal_error');
  });

  it('安全事件列表：查询失败 → 500 internal_error，不含原始消息', async () => {
    vi.mocked(getSecurityEvents).mockRejectedValue(new Error(INTERNAL));
    const res = await eventsGET(req('http://localhost/api/v1/security/events'));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain(INTERNAL);
    expect(JSON.parse(text).error.code).toBe('internal_error');
  });

  it('安全事件统计：查询失败 → 500 internal_error，不含原始消息', async () => {
    vi.mocked(getSecurityEventStats).mockRejectedValue(new Error(INTERNAL));
    const res = await statsGET(req('http://localhost/api/v1/security/stats'));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain(INTERNAL);
    expect(JSON.parse(text).error.code).toBe('internal_error');
  });
});
