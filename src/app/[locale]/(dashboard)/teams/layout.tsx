import { localizedSectionTitle } from '@/lib/page-metadata';

// /teams/* 下多数页面是客户端组件，无法导出 generateMetadata；在段布局上给出
// 本地化的「团队」标题，并重新声明模板，供将来的服务端子页沿用品牌后缀。
export const generateMetadata = localizedSectionTitle('dashboardNav', 'teams');

export default function TeamsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
