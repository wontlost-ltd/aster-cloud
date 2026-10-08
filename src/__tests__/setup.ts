import '@testing-library/jest-dom';
import { vi } from 'vitest';
import * as React from 'react';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => ({
    get: vi.fn(),
  }),
  usePathname: () => '',
}));

// Mock the locale-aware navigation wrapper globally.
//
// `@/i18n/navigation` calls next-intl's `createNavigation()` at module load,
// which transitively `import`s `next/navigation` from inside the next-intl
// package — a path vitest can't always resolve in pnpm's nested layout. Since
// the dashboard now widely imports design-system primitives from
// `@/components/ui` (the barrel re-exports `Breadcrumbs`, which pulls in this
// navigation module), any component test that touches `@/components/ui` would
// otherwise crash with "Cannot find module next/navigation". Mocking the
// wrapper here short-circuits before next-intl runs, matching the per-test
// pattern previously copy-pasted across individual suites.
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => React.createElement('a', { href, ...rest }, children),
  redirect: vi.fn(),
  usePathname: () => '',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  getPathname: ({ href }: { href: string }) => href,
}));

// Mock next-auth/react
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: {
      user: {
        id: 'test-user-id',
        email: 'test@example.com',
        name: 'Test User',
        plan: 'trial',
      },
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    status: 'authenticated',
  }),
  signIn: vi.fn(),
  signOut: vi.fn(),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock fetch globally
global.fetch = vi.fn();

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  ChevronLeft: () => null,
  ChevronRight: () => null,
  ChevronDown: () => null,
  MoreHorizontal: () => null,
  Folder: () => null,
  FolderOpen: () => null,
  Plus: () => null,
  MoreVertical: () => null,
  Pencil: () => null,
  Trash2: () => null,
  FolderPlus: () => null,
  Globe: () => null,
  FileText: () => null,
  Search: () => null,
  X: () => null,
  Check: () => null,
  CheckCircle2: () => null,
  AlertCircle: () => null,
  Info: () => null,
  Settings: () => null,
  User: () => null,
  LogOut: () => null,
  Menu: () => null,
  Home: () => null,
  Play: () => null,
  Edit: () => null,
  Copy: () => null,
  Download: () => null,
  Upload: () => null,
  RefreshCw: () => null,
  Loader2: () => null,
  Eye: () => null,
  EyeOff: () => null,
  Lock: () => null,
  Unlock: () => null,
  Shield: () => null,
  Key: () => null,
  ArrowLeft: () => null,
  ArrowRight: () => null,
  ArrowUp: () => null,
  ArrowDown: () => null,
  ExternalLink: () => null,
  Link: () => null,
  Mail: () => null,
  Calendar: () => null,
  Clock: () => null,
  Star: () => null,
  Heart: () => null,
  Bell: () => null,
  Filter: () => null,
  SortAsc: () => null,
  SortDesc: () => null,
  LayoutGrid: () => null,
  List: () => null,
  Grid: () => null,
  Table: () => null,
  Code: () => null,
  Terminal: () => null,
  Database: () => null,
  Server: () => null,
  Cloud: () => null,
  Wifi: () => null,
  Zap: () => null,
  Activity: () => null,
  BarChart: () => null,
  PieChart: () => null,
  TrendingUp: () => null,
  TrendingDown: () => null,
}));
