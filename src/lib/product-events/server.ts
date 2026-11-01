/**
 * 产品分析事件的服务端写入。
 *
 * 只在服务端调用（依赖 node:crypto 与数据库）。所有入口都 fail-soft：写库失败只记日志，
 * 绝不影响注册、保存、执行等主流程。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { runAfterResponse } from '@/lib/after-response';
import { db, productEvents } from '@/lib/prisma';
import {
  isOncePerActor,
  sanitizeEventProperties,
  type ProductEventName,
} from './definitions';

/**
 * 假名化密钥。未配置 PRODUCT_ANALYTICS_SALT 时用固定默认值：假名仍不含原始 id，但能拿到用户表的人
 * 可以重算出对应关系；生产应配置独立密钥。更换密钥会让新旧假名无法关联（漏斗按密钥分段）。
 */
const DEFAULT_KEY = 'aster-product-analytics-v1';

export function pseudonymize(kind: 'user' | 'tenant', id: string): string {
  const key = process.env.PRODUCT_ANALYTICS_SALT || DEFAULT_KEY;
  return createHmac('sha256', key).update(`${kind}:${id}`).digest('hex').slice(0, 32);
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
