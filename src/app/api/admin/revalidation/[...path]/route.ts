import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { signByokAllowlistHeaders } from '@/lib/api-signing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = process.env.ASTER_POLICY_API_INTERNAL_URL || process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL || 'https://policy.aster-lang.dev';

async function proxy(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const { path } = await context.params;
  const suffix = path.join('/');
  if (!(suffix === 'runs' || /^runs\/[A-Za-z0-9_-]+$/.test(suffix) || suffix === 'invalid')) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const upstreamPath = `/api/v1/admin/revalidation/${suffix}${req.nextUrl.search}`;
  const body = req.method === 'POST' ? await req.text() : null;
  try {
    const headers: Record<string, string> = { ...await signByokAllowlistHeaders(req.method, upstreamPath, body) };
    if (body) headers['Content-Type'] = 'application/json';
    const upstream = await fetch(`${API_BASE}${upstreamPath}`, { method: req.method, headers, body: body || undefined, cache: 'no-store' });
    return new NextResponse(await upstream.text(), { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' } });
  } catch {
    return NextResponse.json({ error: 'upstream_unavailable', message: '无法连接后端重验服务。' }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
