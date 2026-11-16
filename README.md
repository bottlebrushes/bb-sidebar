# BB Sidebar

A stable thread list for [bb](https://github.com/get-bb/bb). Threads stay where you put them while status, snooze, and settle actions remain close at hand.

![BB Sidebar in light mode](docs/screenshots/sidebar-light.jpeg)

![BB Sidebar in dark mode](docs/screenshots/sidebar-dark.jpeg)

![BB Sidebar empty state](docs/screenshots/sidebar-empty.jpeg)

## Features

- Manual ordering plus Recent activity, Date created, and Project sort modes
- Subtle project grouping for projects with multiple active threads
- Pinned, Active, Inactive, Snoozed, Parked, and Settled shelves
- Project filtering
- Automatic project icons with custom overrides
- Expandable child-thread indicators with running and attention states
- Live status, branch, pull request, and provider details
- Workspace port discovery, hover-card details, and optional browser links
- Configurable inactive-thread and automatic cleanup rules
- Native bb navigation, split, rename, archive, and delete flows
- Project submenu on thread cards for settings, rename, local paths, and removal
- Sort under submenu on thread cards to file a thread under another project in the sidebar
- Regenerate a thread title from its last three accepted user messages
- `bb bb-sidebar settle | unsettle | status [threadId]` for agents and scripts; an agent settling its own working thread settles it when the turn ends
- A board: drag the sidebar past bb's usual maximum (460 px) and it turns into a Kanban board of every thread and card; shrink it back and the list returns. Double-click the resize handle to switch between the two
- Board columns per project: local columns edited in **Settings > BB Sidebar > Board**, or a Linear team's workflow states with two-way sync (moves, new cards, titles, priorities, blockers, and sub-items go to Linear; Linear changes arrive within about 20 seconds)
- Blocked-by, sub-item, and duplicate relations on cards; a blocked card sits directly under the card that blocks it, and duplicates fold into their main card
- Cards show the thread working on them, including a parent card's thread for its sub-items, or **Needs agent**
- Board filters: by Linear assignee (My cards, Everyone, Unassigned, or one person) and by column, and sorting by priority; Linear's Blocked column starts hidden
- `bb bb-sidebar board list | show | create | move | block | unblock | parent | duplicate | link | linear | sync` and `board_*` agent tools, so agents can move their own card, block it on another, or file sub-items

## Install

```sh
bb plugin install git:https://github.com/yusuf8834/bb-sidebar.git
```

Then choose **BB Sidebar** under **Settings > Appearance > Sidebar**.

## Development

```sh
npm install
npm run build
bb plugin install path:. --yes
```

## Credits

This project includes code adapted from [bb-plugin-t3sidebar](https://github.com/SawyerHood/bb-plugin-t3sidebar). Its MIT copyright notice remains in [LICENSE](LICENSE).

The sidebar design and interactions are directly inspired by [T3 Code](https://github.com/pingdotgg/t3code), which is also released under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.

Park threads while waiting on someone else. Use **Park thread** in the context menu and **Resume** when ready. Parked threads have no timer and are excluded from automatic cleanup. Opening one leaves it parked; new thread activity brings it back to Active.

Use **Parent** in a thread's context menu to search threads in the same project, choose a parent, or select **None** to remove it. The current parent is checked; the thread itself and its descendants are excluded.

Use **New subthread** in a thread's context menu, or press Cmd+Option+N (Ctrl+Alt+N off Mac) in an open thread, to start a child thread under it. The composer starts from the parent's project, model, permission mode and environment, and every choice can be changed before sending. The shortcut can be rebound in Keyboard Settings.
