// BB Sidebar: a shelved, manually ordered replacement for bb's thread list.
// Manual order stays fixed until the user moves a row. Optional views can sort
// by activity, creation date, or project without changing the saved order.
import {
  definePluginApp,
  type PluginCommandPaletteActionRegistration,
} from "@get-bb/plugin-sdk/app";
import "./src/theme.css";
import { ThreadInbox } from "./src/ThreadInbox";
import { ParentChip } from "./src/ParentChip";
import { SubagentsChip } from "./src/SubagentsChip";
import { SidebarSettings } from "./src/SidebarSettings";
import { SubthreadComposer } from "./src/SubthreadComposer";
import { CARD_PAGE_PATH, CardPage, CardPageHeader } from "./src/board/ui/CardPage";
import { openSubthreadComposer } from "./src/subthread-composer-state";

// bb reads `defaultShortcut` from palette commands (Command on macOS, Control
// elsewhere for `mod`); the pinned SDK's declarations predate the field.
const newSubthreadCommand: PluginCommandPaletteActionRegistration & {
  defaultShortcut: { key: string; mod?: boolean; alt?: boolean; shift?: boolean };
} = {
  id: "new-subthread",
  title: "New subthread",
  defaultShortcut: { key: "n", mod: true, alt: true },
  isAvailable: ({ threadId }) => threadId !== null,
  run: ({ threadId }) => {
    if (threadId !== null) openSubthreadComposer(threadId);
  },
};

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "sidebar-settings",
    component: SidebarSettings,
  });

  app.slots.experimental_threadList({
    id: "inbox",
    title: "BB Sidebar",
    description:
      "Shelves, project filtering, manual ordering, and optional sorted views.",
    component: ThreadInbox,
  });

  // Registered first, so it renders on the left of the children chip: the
  // header then reads up (parent) then down (children).
  //
  // The hidden child is otherwise a dead end — it is not in the list, so this
  // chip is its only route back to the parent.
  app.slots.experimental_threadHeaderAction({
    id: "parent",
    title: "Parent thread",
    component: ParentChip,
  });

  // A flat inbox has nowhere to nest child threads, so the list hides them
  // and this chip gives them a home on their parent's header.
  app.slots.experimental_threadHeaderAction({
    id: "children",
    title: "Child threads",
    component: SubagentsChip,
  });

  // One composer per window, shared by the row menu and the command.
  app.slots.experimental_appOverlay({
    id: "subthread-composer",
    component: SubthreadComposer,
  });
  app.slots.commandPaletteAction(newSubthreadCommand);

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
