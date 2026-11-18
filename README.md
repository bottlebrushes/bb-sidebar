# BB Sidebar

A stable thread list for [bb](https://github.com/get-bb/bb). Threads stay where you put them while status, snooze, and settle actions remain close at hand.

![BB Sidebar in light mode](docs/screenshots/sidebar-light.jpeg)

![BB Sidebar in dark mode](docs/screenshots/sidebar-dark.jpeg)

![BB Sidebar empty state](docs/screenshots/sidebar-empty.jpeg)

## Features

- Manual ordering plus Recent activity, Waiting longest, Date created, and Project sort modes
- Subtle project grouping for projects with multiple active threads
- Optional worktree grouping in Project sort: threads that share a worktree get collapsible groups
- Pinned, Active, Inactive, Snoozed, Parked, and Settled shelves
- Full cards, compact working threads, or compact all threads, with options to keep pinned or woken threads full
- Searchable multi-project filtering, remembered per window across reloads
- Optional project colors with per-project color selection. Names stay colored in every mode; show stripes in full and collapsed mode, full mode only, grouped projects only, or not at all
- Automatic project icons with custom overrides
- Expandable child-thread indicators with running and attention states, on shelf rows too
- Live status, branch, pull request, and provider details, plus statuses set by other plugins
- Command palette commands that snooze or unsnooze the thread in view
- A `bb sidebar` command so agents can list, snooze, settle, park, resume, pin, and re-parent threads
- Persistent provider-limit warnings with one-click scheduled Continue after reset and a cancel option
- Workspace port discovery, hover-card details, and optional browser links
- A Clean button in Settled that previews and closes live terminals and verified thread-owned listening ports, while protecting Active and Working threads
- Configurable inactive-thread and automatic cleanup rules
- Native bb navigation, split, rename, archive, and delete flows
- Project submenu on thread cards for settings, rename, local paths, and removal
- Regenerate a thread title with bb's title generation and the AI service selected for thread titles
- Name threads bb left untitled, such as those whose first prompt is shorter than five words, with up to three background attempts
- Sort under submenu on thread cards to file a thread under another project in the sidebar
- A board: drag the sidebar past bb's usual maximum (460 px) and it turns into a Kanban board of every thread and card; shrink it back and the list returns. Double-click the resize handle to switch between the two
- Board columns per project: local columns edited in **Settings > BB Sidebar > Board**, or a Linear team's workflow states with two-way sync (moves, new cards, titles, priorities, blockers, and sub-items go to Linear; Linear changes arrive within about 20 seconds)
- Blocked-by, sub-item, and duplicate relations on cards; a blocked card sits directly under the card that blocks it, and duplicates fold into their main card
- A card cannot move to a Done (completed) column while any of its sub-items is not Done or Canceled, whether the move comes from dragging, the CLI, or an agent tool. The refusal lists each open sub-item with its column and thread; when someone other than the card's own thread tried the move, that thread is told once per set of open sub-items. Moving to Canceled is never blocked, and a parent Linear already has as Done is left alone
- Cards show the thread working on them, including a parent card's thread for its sub-items, or **Needs agent**
- Board filters: by Linear assignee (My cards, Everyone, Unassigned, or one person) and by column, and sorting by priority; Linear's Blocked column starts hidden
- Pinned projects first: with several projects on the board, every column lists the cards of the projects pinned above the list first, in pin order, then the rest
- Pinned cards: **Pin card** in a card's context menu keeps it at the top of its column, above pinned projects' cards; saved per browser
- `bb sidebar board list | show | create | move | block | unblock | parent | duplicate | link | linear | sync` and `board_*` agent tools, so agents can move their own card, block it on another, or file sub-items
- `bb sidebar settle` from a working thread (an agent settling itself) settles it when the turn ends
- A machine-wait status on cards and rows while a thread's devbox is paused or resuming, and **Stuck** when queued messages stop starting

Park threads while waiting on someone else. Use **Park thread** in the context menu and **Resume** when ready. Parked threads have no timer and are excluded from automatic cleanup. Opening one leaves it parked; new thread activity brings it back to Active.

Use **Parent** in a thread's context menu to search threads in the same project, choose a parent, or select **None** to remove it. The current parent is checked; the thread itself and its descendants are excluded.

Use **New subthread** in a thread's context menu, or press Cmd+Option+N (Ctrl+Alt+N off Mac) in an open thread, to start a child thread under it. The composer starts from the parent's project, model, permission mode and environment, and every choice can be changed before sending. The shortcut can be rebound in Keyboard Settings.

## Install

```sh
bb plugin install git:https://github.com/yusuf8834/bb-sidebar.git
```

Requires bb 0.49.0 or later. Pull request badges and automatic settling read pull request status from bb's bundled GitHub PR Status plugin. While it is disabled, badges are hidden and threads with a workspace are not settled automatically.

Then choose **BB Sidebar** under **Settings > Appearance > Sidebar**.

## Development

```sh
npm install
npm run build
bb plugin install path:. --yes
```

## Credits

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.
