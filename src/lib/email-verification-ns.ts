/**
 * 邮箱验证 token 在 `VerificationToken.identifier` 上的命名空间前缀。
 *
 * ★该表同时被 Auth.js 适配器的 `createVerificationToken` /
 * `useVerificationToken` 使用（magic-link 登录），且那边存**原文 token**、
 * 邮箱验证这边存 `sha256(token)`。当前未启用 Email provider 故两者不会相遇，
 * 但若将来开启：
 *   - 发信侧「作废该 identifier 下全部旧 token」会误删登录魔链；
 *   - 兑换侧会把登录魔链当成验证 token 消费，把「登录」变成「标记已验证」。
 * 加前缀让两套语义在同一张表里天然隔离。
 *
 * 单独成模块而非各自定义：两端必须用**同一个**常量，各写一份迟早分叉。
 */
export const EMAIL_VERIFY_NS = 'email-verify:';
