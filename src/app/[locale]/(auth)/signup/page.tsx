/**
 * Signup page — server entry, mode-gated.
 *
 * SaaS: 渲染 SignupContent（OAuth-only 自助注册）
 * On-Prem: notFound()（账号由管理员邀请；未来 PR 可改成 "Contact your admin"
 *          指引页，但 404 是当前安全默认 — 不暴露端点存在）
 *
 * 客户端实现在 ./signup-content.tsx（'use client'）。本文件保持服务端
 * 仅为了能调 notFound()。
 */
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { CAN_SIGNUP } from '@/lib/deployment-mode';
import { SignupContent } from './signup-content';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignupPage({ params, searchParams }: Props) {
  if (!CAN_SIGNUP) {
    notFound();
  }
  const { locale } = await params;
  setRequestLocale(locale);
  const callbackUrl = (await searchParams)?.callbackUrl;
  return <SignupContent returnTo={typeof callbackUrl === 'string' ? callbackUrl : null} />;
}
