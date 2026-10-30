/**
 * 版本状态不允许该操作：版本不存在、状态不符、或是默认版本。
 *
 * message 与 code 都面向客户端，版本路由原样返回（400）；其它未识别的异常只写服务端日志，
 * 响应是通用文案 + internal_error + requestId（见 `@/lib/api/version-action-error`）。
 * 单独成模块：路由测试常整体 mock version-manager，这个类不随之消失。
 */
export type VersionStateErrorCode =
  | 'version_not_submittable'
  | 'version_not_pending'
  | 'version_not_approved'
  | 'version_not_archivable'
  | 'default_version_locked';

export class VersionStateError extends Error {
  constructor(
    readonly code: VersionStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VersionStateError';
  }
}
