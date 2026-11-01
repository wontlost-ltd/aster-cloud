/**
 * 产品分析事件的服务端写入。
 *
 * 只在服务端调用（依赖 node:crypto 与数据库）。所有入口都 fail-soft：写库失败只记日志，
 * 绝不影响注册、保存、执行等主流程。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { lt } from 'drizzle-orm';
import { runAfterResponse } from '@/lib/after-response';
import { IS_SAAS } from '@/lib/deployment-mode';
import { db, productEvents } from '@/lib/prisma';
import {
  isOncePerActor,
  sanitizeEventProperties,
  type ProductEventName,
} from './definitions';

/**
 * 假名化密钥 PRODUCT_ANALYTICS_SALT。
 *
 * 仓库是公开的，内置默认值等于公开常量：任何拿到用户 / 团队 id 的人都能重算假名。所以 SaaS 生产环境
 * 未配置时 **fail closed**：不记录任何事件、只告警一次（不阻断启动）；开发 / 测试与 on-prem 才用默认值。
 * 更换密钥会让新旧假名无法关联（漏斗按密钥分段），首次上线前就要配好。
 */
const DEV_DEFAULT_KEY = 'aster-product-analytics-dev-only';
let warnedMissingKey = false;

function analyticsKey(): string | null {
  const salt = process.env.PRODUCT_ANALYTICS_SALT;
  if (salt) return salt;
  if (IS_SAAS && process.env.NODE_ENV === 'production') {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn('[product-events] PRODUCT_ANALYTICS_SALT 未配置：SaaS 生产环境不记录产品事件（fail closed）');
    }
    return null;
  }
  return DEV_DEFAULT_KEY;
}

/** 用户 / 租户 id 的 HMAC 假名；密钥不可用（生产未配置）时返回 null。 */
export function pseudonymize(kind: 'user' | 'tenant', id: string): string | null {
  const key = analyticsKey();
  if (!key) return null;
  return createHmac('sha256', key).update(`${kind}:${id}`).digest('hex').slice(0, 32);
}

/** 当前是否能记录事件（生产缺密钥时为 false）。 */
export function productEventsEnabled(): boolean {
  return analyticsKey() !== null;
}

/** 进程内记住已写过的 once 事件，避免每次执行都打一条必然冲突的 INSERT。 */
const ONCE_CACHE_LIMIT = 10_000;
const recordedOnce = new Set<string>();

function rememberOnce(key: string): void {
  if (recordedOnce.size >= ONCE_CACHE_LIMIT) recordedOnce.clear();
  recordedOnce.add(key);
}

export function resetOnceCacheForTests(): void {
  recordedOnce.clear();
  warnedMissingKey = false;
}

export interface RecordProductEventOptions {
  /** 原始用户 id；写库前假名化。 */
  userId?: string | null;
  /** 原始租户 id（团队 id 或个人用户 id）；写库前假名化。 */
  tenantId?: string | null;
  /** 未过滤的属性；按事件白名单过滤后写入。 */
  properties?: unknown;
}

/**
 * 记录一条事件。返回是否真正新写了一行（once 事件重复时为 false）。永不抛错。
 */
export async function recordProductEvent(
  name: ProductEventName,
  options: RecordProductEventOptions = {},
): Promise<boolean> {
  try {
    if (!productEventsEnabled()) return false;
    const actorId = options.userId ? pseudonymize('user', options.userId) : null;
    const tenantId = options.tenantId ? pseudonymize('tenant', options.tenantId) : null;
    const once = isOncePerActor(name);
    if (once && !actorId) return false;
    const dedupeKey = once ? `${name}:${actorId}` : null;
    if (dedupeKey && recordedOnce.has(dedupeKey)) return false;

    const insert = db.insert(productEvents).values({
      id: randomUUID(),
      name,
      actorId,
      tenantId,
      properties: sanitizeEventProperties(name, options.properties ?? {}),
      dedupeKey,
    });
    const rows = dedupeKey
      ? await insert.onConflictDoNothing({ target: productEvents.dedupeKey }).returning({ id: productEvents.id })
      : await insert.returning({ id: productEvents.id });
    if (dedupeKey) rememberOnce(dedupeKey);
    return rows.length > 0;
  } catch (err) {
    console.warn('[product-events] failed to record %s:', name, err);
    return false;
  }
}

/** 响应发出后再写事件，不给请求增加延迟。 */
export function recordProductEventAfterResponse(
  name: ProductEventName,
  options: RecordProductEventOptions = {},
): void {
  runAfterResponse(() => recordProductEvent(name, options));
}

/** 产品事件保留 13 个月（够做同比与季度回看，隐私政策同口径），由 telemetry-retention-gc 每日清理。 */
export const PRODUCT_EVENT_RETENTION_MONTHS = 13;

export async function purgeExpiredProductEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - PRODUCT_EVENT_RETENTION_MONTHS);
  const deleted = await db
    .delete(productEvents)
    .where(lt(productEvents.createdAt, cutoff))
    .returning({ id: productEvents.id });
  return deleted.length;
}
