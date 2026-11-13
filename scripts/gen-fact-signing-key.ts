/**
 * 生成 cloud 平台签发方密钥（ADR 0040 §11 D3；ADR 0046 §11.7 裁定 4、5）。
 *
 *   pnpm fact-key:gen --kid k-2026-11 [--issuer aster-cloud]
 *
 * 用 WebCrypto 生成 Ed25519 密钥对，向 stdout 打印一行 JSON（即 Worker secret `ASTER_FACT_SIGNING_KEY` 的值）：
 * `{"issuer","kid","privateKey":"<pkcs8 base64>","publicKey":"<base64url 原始 32 字节>"}`。
 * 输出含私钥：直接管道给 `wrangler secret put ASTER_FACT_SIGNING_KEY`，不要落盘或贴进工单。
 * 各租户在设置页「启用 Aster Cloud 签发方」时只登记 publicKey。
 */
import { FACT_ISSUER_MAX_LENGTH, FACT_KID_MAX_LENGTH, isFactIssuerSegment } from '../src/services/policy/policy-api';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const kid = arg('kid');
  const issuer = arg('issuer') ?? 'aster-cloud';
  if (!kid || !isFactIssuerSegment(kid, FACT_KID_MAX_LENGTH)) {
    console.error('用法：pnpm fact-key:gen --kid <kid> [--issuer aster-cloud]；kid 只允许 [A-Za-z0-9._~-]，≤ 64 字符');
    process.exit(1);
  }
  if (!isFactIssuerSegment(issuer, FACT_ISSUER_MAX_LENGTH)) {
    console.error('issuer 只允许 [A-Za-z0-9._~-]，≤ 255 字符，且不能是 . 或 ..');
    process.exit(1);
  }
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
  process.stdout.write(`${JSON.stringify({ issuer, kid, privateKey, publicKey })}\n`);
}

main().catch((e: unknown) => {
  console.error('[fact-key:gen] 生成失败', e instanceof Error ? e.message : e);
  process.exit(1);
});
