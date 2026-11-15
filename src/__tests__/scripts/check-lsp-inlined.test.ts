/**
 * 构建产物检查：编辑器 LSP 接线所需的 NEXT_PUBLIC_LSP_HOST 必须在构建期内联进客户端 chunk；
 * 前端 bundle 里不得出现任何 LSP 凭据（#657 验收：鉴权只用运行时 ticket，旧共享 token 已下线）。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLspInlining, inspectChunkDir } from '../../../scripts/check-lsp-inlined.mjs';

// host 已内联的 LSP 客户端 chunk 片段
const CHUNK_OK =
  'let R=(0,o.useCallback)(()=>{let e="lsp.aster-lang.dev";' +
  'if(e){return`${o}//${e}/lsp?locale=${n}${t}`}return`${o}//${window.location.host}/api/lsp?locale=${n}${t}`})';
// host 未内联（构建环境没有该变量）
const CHUNK_HOST_MISSING = CHUNK_OK.replace('"lsp.aster-lang.dev"', 'B.env.NEXT_PUBLIC_LSP_HOST');

describe('inspectLspInlining', () => {
  it('host 已内联 → 通过（编辑器会发起 WebSocket 连接）', () => {
    expect(inspectLspInlining([CHUNK_OK, 'other()'])).toEqual({ ok: true, hasLspClient: true, missing: [], credentialLeaks: [] });
  });

  it('host 未内联 → 不通过并指出缺的变量', () => {
    const r = inspectLspInlining([CHUNK_HOST_MISSING]);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['NEXT_PUBLIC_LSP_HOST']);
  });

  it('非压缩写法 process.env.X 同样识别为未内联', () => {
    const r = inspectLspInlining(['const h = process.env.NEXT_PUBLIC_LSP_HOST; `/lsp?locale=${l}`']);
    expect(r.missing).toEqual(['NEXT_PUBLIC_LSP_HOST']);
  });

  it('★bundle 残留 NEXT_PUBLIC_LSP_TOKEN（引用或已内联）→ 不通过', () => {
    const r = inspectLspInlining([CHUNK_OK, 'x=process.env.NEXT_PUBLIC_LSP_TOKEN']);
    expect(r.ok).toBe(false);
    expect(r.credentialLeaks).toEqual(['NEXT_PUBLIC_LSP_TOKEN']);
  });

  it('★LSP 客户端仍拼 `&token=` 共享凭据 → 不通过', () => {
    const legacy = CHUNK_OK.replace('${n}${t}`}', '${n}&token=${encodeURIComponent("abc")}`}');
    const r = inspectLspInlining([legacy]);
    expect(r.ok).toBe(false);
    expect(r.credentialLeaks).toEqual(['&token=']);
  });

  it('其他功能的 `?token=`（如团队邀请链接）不算 LSP 凭据', () => {
    expect(inspectLspInlining([CHUNK_OK, 'u=`/teams/invite?token=${t}`']).ok).toBe(true);
  });

  it('产物里找不到 LSP 客户端 → 不通过（防止检查空转）', () => {
    expect(inspectLspInlining(['foo()', 'bar()'])).toEqual({ ok: false, hasLspClient: false, missing: [], credentialLeaks: [] });
  });
});

describe('inspectChunkDir', () => {
  it('递归读取目录下的 .js 文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsp-inline-'));
    try {
      mkdirSync(join(dir, 'app'), { recursive: true });
      writeFileSync(join(dir, '499.js'), CHUNK_HOST_MISSING);
      writeFileSync(join(dir, 'app', 'page.js'), 'ok()');
      writeFileSync(join(dir, 'app', 'style.css'), '.x{content:"process.env.NEXT_PUBLIC_LSP_HOST"}');
      expect(inspectChunkDir(dir).missing).toEqual(['NEXT_PUBLIC_LSP_HOST']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
