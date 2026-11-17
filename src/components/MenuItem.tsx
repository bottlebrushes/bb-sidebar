import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Icon, type IconName } from "./Icon";
import { cn } from "../lib/utils";

/** A row of a thread's right-click menu or one of its submenus. */
export function Item({
  children,
  icon,
  destructive = false,
  disabled = false,
  title,
  onSelect,
}: {
  children: ReactNode;
  icon?: IconName;
  destructive?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      disabled={disabled}
      title={title}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-[0.3125rem] text-xs outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        destructive && "text-destructive-text",
      )}
    >
      {icon ? <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
      {children}
    </ContextMenu.Item>
  );
}

export function Separator() {
  return <ContextMenu.Separator className="my-1 h-px bg-border" />;
}
