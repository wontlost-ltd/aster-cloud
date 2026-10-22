/**
 * 应用内页面的本地化 <title>（F19）。
 *
 * 根布局给全站一个营销标题（"Aster Cloud — Replay any credit decision"）；登录后的页面
 * 需要各自的本地化标题，浏览器标签页才能区分。约定：
 * - (dashboard) 布局声明模板 `%s · Aster Cloud`；
 * - 页面用 localizedTitle(命名空间, 键) 生成 generateMetadata，复用界面上已有的导航/标题文案；
 * - 含客户端页面的整段路由（如 /teams/*）用 localizedSectionTitle 放在该段的 layout 上，
 *   它既给本段一个默认标题，也重新声明模板，让子页面的标题继续带上品牌后缀。
 */
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

/** 应用内页面标题模板。 */
export const APP_TITLE_TEMPLATE = '%s · Aster Cloud';

type LocaleParams = { params: Promise<{ locale: string }> };

async function translate(params: LocaleParams['params'], namespace: string, key: string) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace });
  return t(key);
}

/** 页面级：标题 = 文案（由上层模板补品牌后缀）。 */
export function localizedTitle(namespace: string, key: string) {
  return async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
    return { title: await translate(params, namespace, key) };
  };
}

/** 路由段级（layout）：本段默认标题 + 重新声明模板。 */
export function localizedSectionTitle(namespace: string, key: string) {
  return async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
    return {
      title: { default: await translate(params, namespace, key), template: APP_TITLE_TEMPLATE },
    };
  };
}
