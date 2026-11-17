import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Add01Icon,
  Alert02Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  ArrowUp01Icon,
  ArrowUpDownIcon,
  BrushCleaningIcon,
  Calendar03Icon,
  CancelCircleIcon,
  Car05Icon,
  CheckListIcon,
  Clock01Icon,
  ComputerIcon,
  ComputerTerminal01Icon,
  Mail01Icon,
  MailOpen01Icon,
  Edit02Icon,
  Delete02Icon,
  FolderGitIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  HelpCircleIcon,
  Link01Icon,
  LinkSquare02Icon,
  Notification01Icon,
  NotificationOff01Icon,
  Loading03Icon,
  PauseCircleIcon,
  PinIcon,
  PinOffIcon,
  PlugSocketIcon,
  Pulse01Icon,
  PowerIcon,
  RefreshIcon,
  PulseRectangle01Icon,
  Search01Icon,
  StopCircleIcon,
  Target02Icon,
  Tick02Icon,
  UserAdd01Icon,
  Unlink01Icon,
  WorkflowCircle03Icon,
  Yoga02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "../lib/utils";

const ICON_MAP = {
  Add: Add01Icon,
  Alert: Alert02Icon,
  Delete: Delete02Icon,
  ExternalLink: LinkSquare02Icon,
  Link: Link01Icon,
  Notification: Notification01Icon,
  NotificationOff: NotificationOff01Icon,
  Power: PowerIcon,
  Refresh: RefreshIcon,
  Target: Target02Icon,
  Unlink: Unlink01Icon,
  ArrowTurnBackward: ArrowTurnBackwardIcon,
  ArrowUpDown: ArrowUpDownIcon,
  Clean: BrushCleaningIcon,
  Calendar: Calendar03Icon,
  Car: Car05Icon,
  Check: Tick02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronLeft: ArrowLeft01Icon,
  ChevronRight: ArrowRight01Icon,
  ChevronUp: ArrowUp01Icon,
  CircleQuestion: HelpCircleIcon,
  CircleX: CancelCircleIcon,
  Clock: Clock01Icon,
  Computer: ComputerIcon,
  Edit: Edit02Icon,
  FolderGit: FolderGitIcon,
  GitBranch: GitBranchIcon,
  GitPullRequest: GitPullRequestIcon,
  ListTodo: CheckListIcon,
  Loading: Loading03Icon,
  Mail: Mail01Icon,
  MailOpen: MailOpen01Icon,
  Meditation: Yoga02Icon,
  PauseCircle: PauseCircleIcon,
  Pin: PinIcon,
  PinOff: PinOffIcon,
  Plug: PlugSocketIcon,
  Pulse: Pulse01Icon,
  Working: PulseRectangle01Icon,
  Search: Search01Icon,
  StopCircle: StopCircleIcon,
  Terminal: ComputerTerminal01Icon,
  UserRoundPlus: UserAdd01Icon,
  Workflow: WorkflowCircle03Icon,
} as const satisfies Record<string, IconSvgElement>;

export type IconName = keyof typeof ICON_MAP;

export function Icon({
  name,
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: {
  name: IconName;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}) {
  return (
    <HugeiconsIcon
      icon={ICON_MAP[name]}
      className={cn(className)}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      data-icon={name}
    />
  );
}
