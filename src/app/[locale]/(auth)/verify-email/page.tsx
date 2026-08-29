'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { extractErrorMessage } from '@/lib/api/error-envelope';

/**
 * 邮件里的验证链接落地页。
 *
 * 与 reset-password 不同：此处**无需用户输入**，进页即兑换 token。
 * 故不做表单，只呈现三态（处理中 / 成功 / 失败）。
 *
 * ★用 ref 做一次性保护：React 18 StrictMode 在开发下会重复执行 effect，
 * 而 token 是**用后即焚**的——第二次调用必然拿到「无效或已过期」，
 * 页面会把一次成功的验证显示成失败。不能只靠 effect 依赖数组。
 */
function VerifyEmailContent() {
  const t = useTranslations('auth.verifyEmail');
  const tNav = useTranslations('nav');
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [state, setState] = useState<'pending' | 'success' | 'error'>('pending');
  const [error, setError] = useState('');
  const fired = useRef(false);

  useEffect(() => {
    if (!token || fired.current) return;
    fired.current = true;

    void (async () => {
      try {
        const res = await fetch('/api/user/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(extractErrorMessage(data) || t('invalidToken'));
        }
        setState('success');
      } catch (err) {
        setError(err instanceof Error ? err.message : t('invalidToken'));
        setState('error');
      }
    })();
  }, [token, t]);

  const shell = (title: string, body: React.ReactNode) => (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <Link href="/" className="flex justify-center">
            <span className="text-3xl font-bold text-primary">{tNav('brand')}</span>
          </Link>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">{title}</h2>
        </div>
        {body}
      </div>
    </div>
  );

  if (!token) {
    return shell(
      t('invalidToken'),
      <>
        <div className="rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-700">{t('invalidToken')}</p>
        </div>
        <div className="text-center">
          <Link href="/settings" className="font-medium text-primary hover:text-primary">
            {t('backToSettings')}
          </Link>
        </div>
      </>,
    );
  }

  if (state === 'pending') {
    return shell(
      t('verifying'),
      <div className="rounded-md bg-gray-100 p-4">
        <p className="text-sm text-gray-700">{t('verifying')}</p>
      </div>,
    );
  }

  if (state === 'success') {
    return shell(
      t('successTitle'),
      <>
        <div className="rounded-md bg-green-50 p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-green-400" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="ml-3">
              <p className="text-sm font-medium text-green-800">{t('successMessage')}</p>
            </div>
          </div>
        </div>
        <div className="text-center">
          <Link href="/dashboard" className="font-medium text-primary hover:text-primary">
            {t('goToDashboard')}
          </Link>
        </div>
      </>,
    );
  }

  return shell(
    t('invalidToken'),
    <>
      <div className="rounded-md bg-red-50 p-4">
        <p className="text-sm text-red-700">{error}</p>
      </div>
      <div className="text-center">
        <Link href="/settings" className="font-medium text-primary hover:text-primary">
          {t('backToSettings')}
        </Link>
      </div>
    </>,
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}
    >
      <VerifyEmailContent />
    </Suspense>
  );
}
