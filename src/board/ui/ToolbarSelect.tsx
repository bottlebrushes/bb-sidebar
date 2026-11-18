import type { ComponentProps } from "react";
import { Icon } from "../../components/Icon";
import { cn } from "../../lib/utils";

/**
 * A board toolbar select. The native control is drawn without its platform
 * chrome: macOS's popup button has fixed metrics that clip 11px text in a
 * 24px-tall control, so the select keeps its own height and line box and a
 * chevron is drawn over it instead.
 */
export function ToolbarSelect({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <span className={cn("relative inline-flex h-6 shrink-0 items-center", className)}>
      <select
        {...props}
        className="h-6 w-full min-w-0 cursor-pointer appearance-none truncate rounded border border-border bg-background py-0 pl-1.5 pr-5 text-[11px] leading-[22px] text-foreground hover:bg-accent disabled:cursor-default disabled:opacity-50"
      >
        {children}
      </select>
      <Icon
        name="ChevronDown"
        className="pointer-events-none absolute right-1 size-3 text-muted-foreground"
        aria-hidden
      />
    </span>
  );
}
