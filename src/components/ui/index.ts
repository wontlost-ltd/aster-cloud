/**
 * @/components/ui — single import surface for design-system primitives.
 *
 * Re-exports from @aster-cloud/ui so consumers can keep using the
 * familiar `import { Button, … } from '@/components/ui'` path even as
 * primitives migrate into the npm-published design system. We also
 * re-export the few aster-cloud-specific wrappers that adapt design-
 * system primitives to in-app concerns (e.g. Breadcrumbs needs the
 * next-intl Link).
 *
 * If you're adding a new shared primitive: build it in
 * `aster-design-system/packages/ui` first, cut a `@aster-cloud/ui`
 * release, then re-export here. Don't grow this directory with new
 * primitives — that's the anti-pattern we just unwound.
 */

export {
  // Foundations
  cn,
  // Actions
  Button,
  buttonVariants,
  IconButton,
  Dropdown,
  DropdownItem,
  DropdownSeparator,
  DropdownLabel,
  // Surfaces
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardBody,
  CardFooter,
  Container,
  Stack,
  Separator,
  Wordmark,
  // Form controls
  Input,
  Textarea,
  Label,
  Select,
  Toggle,
  ListSearchInput,
  // Status / feedback
  Alert,
  AlertTitle,
  AlertDescription,
  Badge,
  Skeleton,
  Spinner,
  Toaster,
  toast,
  // Navigation / structure
  PageHeader,
  // Data display
  DataTable,
  StatCard,
  EmptyState,
} from '@aster-cloud/ui';

export type {
  ButtonProps,
  IconButtonProps,
  DropdownProps,
  DropdownItemProps,
  ContainerProps,
  StackProps,
  SeparatorProps,
  WordmarkProps,
  InputProps,
  TextareaProps,
  LabelProps,
  SelectProps,
  ToggleProps,
  ListSearchInputProps,
  AlertProps,
  BadgeProps,
  SpinnerProps,
  ToasterProps,
  PageHeaderProps,
  DataTableColumn,
  DataTableProps,
  StatCardProps,
  StatCardTone,
  EmptyStateProps,
  ConfirmDialogVariant,
} from '@aster-cloud/ui';

// Breadcrumbs needs a routing-aware Link in this app, so we wrap the
// package primitive with the next-intl Link rather than re-exporting
// it directly. Same goes for any future primitive that needs deeper
// integration.
export {
  Breadcrumbs,
  type BreadcrumbsProps,
  type BreadcrumbItem,
} from './breadcrumbs';

// TODO(design-system): Pagination lives in aster-cloud temporarily;
// migrate to @aster-cloud/ui once the design system release lands.
// See src/components/ui/pagination.tsx for the rationale.
export { Pagination, type PaginationProps } from './pagination';

// ConfirmDialog 的按钮缺省文案需走 next-intl，故同样包一层（见 ./confirm-dialog）。
export { ConfirmDialog, type ConfirmDialogProps } from './confirm-dialog';
