/**
 * 业务角色（ADR 0042 §2.1）。
 *
 * 词表是自由文本，与 Verdict 的 required role 按原样精确匹配（大小写敏感）。
 * 入库前一律经 normalizeBusinessRoles；读取一律经 loadBusinessRoles（个人租户读 User，团队读 TeamMember）。
 */
import { and, eq } from 'drizzle-orm';
import { db, users, teamMembers } from '@/lib/prisma';

// 可打印 ASCII（0x20–0x7E）去掉逗号（0x2C），1–64 字符：角色会作为 HTTP 头下发（只能是 Latin-1 子集），
// 且 aster-api 在 X-User-Business-Roles 头与 HMAC canonical 中以逗号拼接多个角色，含逗号会被拆错
const ROLE_RE = /^[\x20-\x2B\x2D-\x7E]{1,64}$/;
export const MAX_BUSINESS_ROLES = 16;

export class BusinessRoleError extends Error {
  constructor() {
    super('invalid_business_role');
    this.name = 'BusinessRoleError';
  }
}

/**
 * 词表归一（ADR 0042 §2.1）：trim、可打印 ASCII 1–64 且不含逗号、去重保序、≤16；任何一项不合法整体拒绝。
 * 禁逗号是因为 aster-api 以逗号拼接已验证角色（X-User-Business-Roles 头与 HMAC canonical）。
 */
export function normalizeBusinessRoles(input: unknown): string[] {
  if (!Array.isArray(input)) throw new BusinessRoleError();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') throw new BusinessRoleError();
    const role = item.trim();
    if (!ROLE_RE.test(role)) throw new BusinessRoleError();
    if (!out.includes(role)) out.push(role);
  }
  if (out.length > MAX_BUSINESS_ROLES) throw new BusinessRoleError();
  return out;
}

/** 当前用户在某租户的已验证角色：个人租户（tenantId === userId）读 User，团队读 TeamMember；无行 → []。 */
export async function loadBusinessRoles(userId: string, tenantId: string): Promise<string[]> {
  if (tenantId === userId) {
    const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { businessRoles: true } });
    return u?.businessRoles ?? [];
  }
  const m = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, tenantId), eq(teamMembers.userId, userId)),
    columns: { businessRoles: true },
  });
  return m?.businessRoles ?? [];
}
