// BB Sidebar: a shelved, manually ordered replacement for bb's thread list.
// Manual order stays fixed until the user moves a row. Optional views can sort
// by activity, creation date, or project without changing the saved order.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./src/theme.css";
import { ThreadInbox } from "./src/ThreadInbox";
import { ParentChip } from "./src/ParentChip";
import { SidebarSettings } from "./src/SidebarSettings";
import { registerThreadHeaderAction } from "./src/bb-sdk";
import { registerSnoozeCommands } from "./src/lib/snooze-commands";
import { SubthreadComposer } from "./src/SubthreadComposer";
import { CARD_PAGE_PATH, CardPage, CardPageHeader } from "./src/board/ui/CardPage";
import { openSubthreadComposer } from "./src/useSubthreadComposer";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "sidebar-settings",
    component: SidebarSettings,
  });

  app.slots.experimental_threadList({
    id: "inbox",
    title: "BB Sidebar",
    description: "Shelves, project filtering, manual ordering, and optional sorted views.",
    component: ThreadInbox,
  });

  // An open child thread names its parent here. The list draws a child inside
  // its parent's row, not as a row of its own, so this chip is the way back
  // up from the child's own page.
  registerThreadHeaderAction(app.slots, {
    id: "parent",
    title: "Parent thread",
    component: ParentChip,
  });

  // Palette commands act on the thread in view, so a thread can be snoozed
  // without finding its row.
  registerSnoozeCommands(app.commands);

  // One composer per window, shared by the row menu and the command.
  app.slots.experimental_appOverlay({
    id: "subthread-composer",
    component: SubthreadComposer,
  });
  app.commands.register({
    id: "new-subthread",
    title: "New subthread",
    defaultShortcut: { key: "n", mod: true, alt: true },
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId !== null) openSubthreadComposer(threadId);
    },
  });

  // A board card without a thread: its own route, so back and forward walk
  // between cards, with the card's Linear issue on the title bar.
  app.slots.navPanel({
    id: "card",
    title: "Board card",
    icon: "LayoutDashboard",
    path: CARD_PAGE_PATH,
    component: CardPage,
    headerContent: CardPageHeader,
  });
});
