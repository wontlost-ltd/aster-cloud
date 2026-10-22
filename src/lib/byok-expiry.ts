/**
 * BYOK key 的「已失效」判定——推理选择层（byok-envelope）与设置页状态徽标共用。
 *
 * 口径：`expiresAt <= now` 即失效（失效日期当天 00:00 UTC 起不可用，见 ai-keys 表单的
 * 存储约定）。两处必须一致：否则会出现「页面显示活跃、推理却跳过」或反过来的错位。
 * 纯函数、无服务端依赖，客户端组件可直接引用。
 */
export function isByokKeyExpired(
  expiresAt: Date | string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (expiresAt == null) return false;
  const ms = typeof expiresAt === 'string' ? Date.parse(expiresAt) : expiresAt.getTime();
  // 无法解析的日期按「未设置」处理：宁可显示活跃，也不凭坏数据把 key 判死。
  if (Number.isNaN(ms)) return false;
  return ms <= nowMs;
}
