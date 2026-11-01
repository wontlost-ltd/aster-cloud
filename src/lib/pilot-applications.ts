/**
 * 落地页「申请试点」表单：校验 / 规范化、落库、管理端列表与 CSV 导出。
 *
 * 只收表单本身的字段：不存 IP，来源只存 utm_* 与 referrer 主机名；邮箱域名单独成列并标出个人邮箱，
 * 管理端据此区分企业线索。
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { db, pilotApplications, type PilotApplication } from '@/lib/prisma';
import { locales } from '@/i18n/config';
import { isDisposableEmail } from '@/lib/email-disposable';
import { isFreeMailDomain } from '@/lib/free-mail-domains';
import { sanitizeEventProperties } from '@/lib/product-events/definitions';
import {
  PILOT_ROLES,
  PILOT_USE_CASES,
  isSolutionSlug,
  type PilotRole,
  type PilotUseCase,
  type SolutionSlug,
} from '@/lib/solutions';

const MAX_EMAIL = 254;
const MAX_COMPANY = 200;
const MAX_PAIN_POINT = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PilotApplicationInput {
  email: string;
  emailDomain: string;
  freeMailDomain: boolean;
  company: string;
  role: PilotRole;
  useCases: PilotUseCase[];
  painPoint: string | null;
  landingPage: SolutionSlug;
  locale: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  referrerHost: string | null;
}

export type ParseResult = { ok: true; value: PilotApplicationInput } | { ok: false; field: string };

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseUseCases(value: unknown): PilotUseCase[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((v) => (PILOT_USE_CASES as readonly unknown[]).includes(v))) return null;
  return [...new Set(value as PilotUseCase[])];
}

/** 校验并规范化一次提交；失败只返回出错字段名（前端据此本地化提示）。 */
export function parsePilotApplication(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, field: 'body' };
  const body = raw as Record<string, unknown>;

  const email = trimmed(body.email).toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > MAX_EMAIL || isDisposableEmail(email)) {
    return { ok: false, field: 'email' };
  }
  const company = trimmed(body.company);
  if (!company || company.length > MAX_COMPANY) return { ok: false, field: 'company' };
  const role = body.role;
  if (!(PILOT_ROLES as readonly unknown[]).includes(role)) return { ok: false, field: 'role' };
  const useCases = parseUseCases(body.useCases);
  if (!useCases) return { ok: false, field: 'useCases' };
  const painPoint = trimmed(body.painPoint);
  if (painPoint.length > MAX_PAIN_POINT) return { ok: false, field: 'painPoint' };
  if (body.consent !== true) return { ok: false, field: 'consent' };
  if (!isSolutionSlug(body.page)) return { ok: false, field: 'page' };
  if (!(locales as readonly unknown[]).includes(body.locale)) return { ok: false, field: 'locale' };

  // 归因与落地页访问事件同一套白名单（UTM 字符集、referrer 只留主机名）。
  const attribution = sanitizeEventProperties('landing_viewed', body.attribution);
  const attr = (key: string) => (typeof attribution[key] === 'string' ? (attribution[key] as string) : null);
  const emailDomain = email.slice(email.lastIndexOf('@') + 1);

  return {
    ok: true,
    value: {
      email,
      emailDomain,
      freeMailDomain: isFreeMailDomain(emailDomain),
      company,
      role: role as PilotRole,
      useCases,
      painPoint: painPoint || null,
      landingPage: body.page,
      locale: body.locale as string,
      utmSource: attr('utmSource'),
      utmMedium: attr('utmMedium'),
      utmCampaign: attr('utmCampaign'),
      utmTerm: attr('utmTerm'),
      utmContent: attr('utmContent'),
      referrerHost: attr('referrerHost'),
    },
  };
}

/** 同一邮箱 24 小时内只收一份申请；重复提交按成功回复但不落新行。 */
export const DUPLICATE_WINDOW_MS = 24 * 3600 * 1000;

export async function hasRecentPilotApplication(email: string, now = new Date()): Promise<boolean> {
  const row = await db.query.pilotApplications.findFirst({
    where: and(
      eq(pilotApplications.email, email),
      gte(pilotApplications.createdAt, new Date(now.getTime() - DUPLICATE_WINDOW_MS)),
    ),
    columns: { id: true },
  });
  return Boolean(row);
}

export async function insertPilotApplication(input: PilotApplicationInput, now = new Date()): Promise<string> {
  const id = randomUUID();
  await db.insert(pilotApplications).values({ id, ...input, consentAt: now, createdAt: now });
  return id;
}

/** 管理端列表：最新在前。导出也用它，上限防止一次拉全表。 */
export async function listPilotApplications(limit = 5000): Promise<PilotApplication[]> {
  return db.query.pilotApplications.findMany({
    orderBy: [desc(pilotApplications.createdAt)],
    limit,
  });
}

const CSV_COLUMNS = [
  'createdAt', 'email', 'emailDomain', 'freeMailDomain', 'company', 'role', 'useCases', 'painPoint',
  'landingPage', 'locale', 'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent', 'referrerHost',
  'consentAt',
] as const;

function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (value instanceof Date) text = value.toISOString();
  else if (Array.isArray(value)) text = value.join('|');
  else text = String(value);
  // 表格软件会把以 = + - @（含全角 ＝＋－＠）或制表 / 回车开头、或前导空白后紧跟这些字符的单元格当公式执行；
  // 表单字段来自匿名提交，一律加 ' 前缀。
  if (/^\s*[=+\-@＝＋－＠\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV（CRLF 行尾）；多选用例以 `|` 连接；公式前缀字符一律转义。 */
export function pilotApplicationsToCsv(rows: PilotApplication[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((col) => csvCell(row[col])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** 试点申请保留 24 个月（隐私政策同口径），由 telemetry-retention-gc 每日清理。 */
export const PILOT_APPLICATION_RETENTION_MONTHS = 24;

export function monthsBefore(now: Date, months: number): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

export async function purgeExpiredPilotApplications(now = new Date()): Promise<number> {
  const deleted = await db
    .delete(pilotApplications)
    .where(lt(pilotApplications.createdAt, monthsBefore(now, PILOT_APPLICATION_RETENTION_MONTHS)))
    .returning({ id: pilotApplications.id });
  return deleted.length;
}

/** 管理端删除单条申请（应申请人要求等）。返回是否删到了行。 */
export async function deletePilotApplication(id: string): Promise<boolean> {
  const deleted = await db
    .delete(pilotApplications)
    .where(eq(pilotApplications.id, id))
    .returning({ id: pilotApplications.id });
  return deleted.length > 0;
}
