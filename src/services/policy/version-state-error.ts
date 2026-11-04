/**
 * 版本状态不允许该操作：版本不存在、状态不符、或是默认版本。
 *
 * message 与 code 都面向客户端，版本路由原样返回（400）；其它未识别的异常只写服务端日志，
 * 响应是通用文案 + internal_error + requestId（见 `@/lib/api/version-action-error`）。
 * 单独成模块：路由测试常整体 mock version-manager，这个类不随之消失；前端也从这里取错误码清单（不含服务端依赖）。
 */
export const VERSION_STATE_ERROR_CODES = [
  'version_not_submittable',
  'version_not_pending',
  'version_not_approved',
  'version_not_archivable',
  'default_version_locked',
] as const;

export type VersionStateErrorCode = (typeof VERSION_STATE_ERROR_CODES)[number];

/** 响应里的错误码是否为版本状态错误：界面据此按 code 本地化（`policies.versions.versionErrorCodes.*`，#697）。 */
export function isVersionStateErrorCode(code: unknown): code is VersionStateErrorCode {
  return typeof code === 'string' && (VERSION_STATE_ERROR_CODES as readonly string[]).includes(code);
}

export class VersionStateError extends Error {
  constructor(
    readonly code: VersionStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VersionStateError';
  }
}
