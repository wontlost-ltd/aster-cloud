'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Container } from '@/components/ui';
import { extractErrorMessage } from '@/lib/api/error-envelope';

interface InvitationInfo {
  teamName: string;
  role: string;
  email: string;
}

export default function AcceptInvitePage() {
  const t = useTranslations('teams');
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [isLoading, setIsLoading] = useState(true);
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState('');
  const [_invitationInfo, _setInvitationInfo] = useState<InvitationInfo | null>(null);

  useEffect(() => {
    if (!token) {
      // 根据 URL token 缺失同步错误态，属合法的外部状态(URL)→本地状态同步。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError(t('acceptInvite.invalid'));
      setIsLoading(false);
      return;
    }

    // 验证邀请令牌（可选：获取邀请详情）
    // 为简化实现，直接显示接受按钮
    setIsLoading(false);
  }, [token, t]);

  const handleAccept = async () => {
    if (!token) return;

    setIsAccepting(true);
    setError('');

    try {
      const res = await fetch('/api/teams/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(extractErrorMessage(data) || 'Failed to accept invitation');
      }

      // 接受成功，跳转到团队页面
      router.push(`/teams/${data.team.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('acceptInvite.invalid'));
      setIsAccepting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!token) {
    return (
      <Container size="xl" className="py-6 sm:py-10">
        <div className="max-w-md mx-auto">
          <div className="bg-bg shadow rounded-lg p-6 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <svg
                className="h-6 w-6 text-red-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <h3 className="mt-4 text-lg font-medium text-fg">
              {t('acceptInvite.invalid')}
            </h3>
            <p className="mt-2 text-sm text-fg-muted">
              {t('acceptInvite.expired')}
            </p>
            <div className="mt-6">
              <Link
                href="/teams"
                className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover"
              >
                {t('backToTeams')}
              </Link>
            </div>
          </div>
        </div>
      </Container>
    );
  }

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <div className="max-w-md mx-auto">
        <div className="bg-bg shadow rounded-lg p-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-subtle">
            <svg
              className="h-6 w-6 text-primary"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </div>
          <h3 className="mt-4 text-lg font-medium text-fg">
            {t('acceptInvite.title')}
          </h3>
          <p className="mt-2 text-sm text-fg-muted">{t('acceptInvite.joining')}</p>

          {error && (
            <div className="mt-4 rounded-md bg-red-50 p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <div className="mt-6 space-y-3">
            <button
              onClick={handleAccept}
              disabled={isAccepting}
              className="w-full inline-flex justify-center items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover disabled:opacity-50"
            >
              {isAccepting ? (
                <>
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  {t('acceptInvite.accepting')}
                </>
              ) : (
                t('acceptInvite.accept')
              )}
            </button>
            <Link
              href="/teams"
              className="block w-full text-center rounded-md border border-border-strong bg-bg px-4 py-2 text-sm font-medium text-fg hover:bg-bg-subtle"
            >
              {t('cancel')}
            </Link>
          </div>
        </div>
      </div>
    </Container>
  );
}
