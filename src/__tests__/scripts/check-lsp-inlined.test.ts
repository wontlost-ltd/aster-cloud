/**
 * 构建产物检查：编辑器 LSP 接线所需的 NEXT_PUBLIC_LSP_HOST / NEXT_PUBLIC_LSP_TOKEN 必须在构建期内联进客户端 chunk。
 *
 * 生产复测（2026-10-30 A4）：线上 chunk 里 host 已内联为 "lsp.aster-lang.dev"，token 却残留为
 * `B.env.NEXT_PUBLIC_LSP_TOKEN`（构建环境没有该变量）→ isLspConfigured 判为未配置 → 编辑页从不建立 WebSocket。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLspInlining, inspectChunkDir } from '../../../scripts/check-lsp-inlined.mjs';

// 线上 chunk 499.1746dbcffb6ca4c7.js 的真实片段（token 未内联）
const PROD_CHUNK_TOKEN_MISSING =
  'let R=(0,o.useCallback)(()=>{let e="lsp.aster-lang.dev",r=B.env.NEXT_PUBLIC_LSP_TOKEN,t=r?`&token=${encodeURIComponent(r)}`:"";' +
  'if(e){return`${o}//${r}/lsp?locale=${n}${t}`}return`${o}//${window.location.host}/api/lsp?locale=${n}${t}`})';
// 编辑器组件 chunk：isLspConfigured(host, token) 的调用点
const EDITOR_CHUNK_TOKEN_MISSING = 'let ex=function(e,t){return!!e}("lsp.aster-lang.dev",B.env.NEXT_PUBLIC_LSP_TOKEN)&&!g;';
// token 已内联时的同一片段
const PROD_CHUNK_OK = PROD_CHUNK_TOKEN_MISSING.replace('B.env.NEXT_PUBLIC_LSP_TOKEN', '"tok-test"');
const EDITOR_CHUNK_OK = EDITOR_CHUNK_TOKEN_MISSING.replace('B.env.NEXT_PUBLIC_LSP_TOKEN', '"tok-test"');

describe('inspectLspInlining', () => {
  it('复现生产：token 未内联 → 判定不通过并指出缺的变量', () => {
    const r = inspectLspInlining([PROD_CHUNK_TOKEN_MISSING, EDITOR_CHUNK_TOKEN_MISSING, 'other()']);
    expect(r.ok).toBe(false);
    expect(r.hasLspClient).toBe(true);
    expect(r.missing).toEqual(['NEXT_PUBLIC_LSP_TOKEN']);
  });

  it('host 与 token 都内联 → 通过（编辑器会发起 WebSocket 连接）', () => {
    const r = inspectLspInlining([PROD_CHUNK_OK, EDITOR_CHUNK_OK]);
    expect(r).toEqual({ ok: true, hasLspClient: true, missing: [] });
  });

  it('host 也未内联 → 两个变量都报', () => {
    const chunk = PROD_CHUNK_TOKEN_MISSING.replace('"lsp.aster-lang.dev"', 'B.env.NEXT_PUBLIC_LSP_HOST');
    expect(inspectLspInlining([chunk]).missing).toEqual(['NEXT_PUBLIC_LSP_HOST', 'NEXT_PUBLIC_LSP_TOKEN']);
  });

  it('非压缩写法 process.env.X 同样识别为未内联', () => {
    const r = inspectLspInlining(['const t = process.env.NEXT_PUBLIC_LSP_TOKEN; `/lsp?locale=${l}`']);
    expect(r.missing).toEqual(['NEXT_PUBLIC_LSP_TOKEN']);
  });

  it('产物里找不到 LSP 客户端 → 不通过（防止检查空转）', () => {
    expect(inspectLspInlining(['foo()', 'bar()'])).toEqual({ ok: false, hasLspClient: false, missing: [] });
  });
});

describe('inspectChunkDir', () => {
  it('递归读取目录下的 .js 文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsp-inline-'));
    try {
      mkdirSync(join(dir, 'app'), { recursive: true });
      writeFileSync(join(dir, '499.js'), PROD_CHUNK_TOKEN_MISSING);
      writeFileSync(join(dir, 'app', 'page.js'), EDITOR_CHUNK_TOKEN_MISSING);
      writeFileSync(join(dir, 'app', 'style.css'), '.x{content:"process.env.NEXT_PUBLIC_LSP_HOST"}');
      expect(inspectChunkDir(dir).missing).toEqual(['NEXT_PUBLIC_LSP_TOKEN']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
