# Changelog

## Unreleased

### Added

- **New subthread** in a thread's context menu, and as a command bound to Cmd+Option+N (Ctrl+Alt+N off Mac) for the open thread, opens bb's new-thread composer filed under that thread. It starts from the parent's project, model, permission mode and environment; any of them can be changed before sending. Rebind it in Keyboard Settings.
- **Mute notifications** / **Unmute notifications** in a thread's context menu, when the Chime (Notifications & Sounds) plugin is installed. A muted thread and all of its descendants stop sending sounds, banners, and push notifications; a descendant shows **Muted by parent thread** instead.
- **`bb bb-sidebar settle | unsettle | status [threadId]`**, a CLI for the shelves that defaults to the thread running it. An idle thread settles at once. A working thread (an agent settling itself) settles when its turn ends, so its runtime is not stopped mid-turn and the turn's end does not wake it again; a failed turn or any manual shelf choice drops the waiting settle.
- **Sort under** in a thread's context menu files the thread under another project in this sidebar: its card label, project grouping, and project filter follow the choice. bb cannot move a thread between projects, so this helps when a thread's work moved to another checkout. Links still use the project bb created the thread in, and choosing that project again clears the placement.
- **Board.** Dragging the sidebar wider than bb's 460 px maximum turns it into a Kanban board; at 460 px or less the normal list returns, and double-clicking the resize handle switches between them. Opening a card keeps the board at its width, with the chat beside it. Every top-level thread is a card (settled ones in the last completed column for 14 days), and cards can also exist without a thread: clicking one opens a new chat in bb's main composer, seeded with the card, and the thread it starts is linked to the card. In **All projects**, columns every project in view has come first and project-specific ones follow. A failed board load (such as a 504 while bb connect reconnects) retries after 1, 2, 4… up to 30 seconds and when the window regains focus.
- **Linear sync for the board.** Link a project to a Linear team (optionally one Linear project, my issues or all) in **Settings > BB Sidebar > Board**, with the API key in `bb plugin config bb-sidebar set linearApiKey <key>`. Columns follow the team's workflow states; moving, creating, renaming, blocking, and nesting cards write to Linear first, and Linear changes are pulled every 20 seconds, with a full pass every 5 minutes. Threads whose branch names an issue (`tra-123-…`) are linked to its card.
- **Blockers and sub-items** from a card's context menu, the `board_set_relation` agent tool, or `bb bb-sidebar board block | parent`. Blocked cards are drawn under their blocker; parents show sub-item progress.
- **A parent card waits for its sub-items.** Moving a card to a Done (completed) column is refused while any sub-item is not Done or Canceled, from the board, `bb bb-sidebar board move` (exits 1), and `board_update_card` alike. The error names each open sub-item with its column and its thread (`@thread:…` or `no thread`). On the board it shows as a small toast with a close button: the summary, then one line per sub-item, cut to fit. A Linear card's sub-issues are read from Linear at that moment, so ones outside the board's sync scope count too. When the move came from the board UI, another thread, or the plugin itself, the card's own thread also gets the message, once per set of open sub-items. Moving to Canceled is never blocked; Linear changes pulled into the board are not checked.
- **Duplicates** follow Linear's "duplicate of" relation both ways: a duplicate folds into its main card (a ⧉ count that expands to the list) and shows on its own with "Duplicate of …" only when the main is filtered out. Mark one from the card menu (**Duplicate of…**, **Not a duplicate**, **Remove duplicate**), `board_set_relation` with `duplicateOf`, or `bb bb-sidebar board duplicate`. A duplicate of a duplicate is filed under the main card.
- **Linear projects (epics) on cards.** A card shows its Linear project as a chip after its id. **Linear project…** in a Linear card's context menu puts it in one of the team's projects (active ones first) or takes it out; agents do the same with `linearProject` on `board_update_card` and `board_create_card`, and the CLI with `bb bb-sidebar board project <cardRef> <project name|->`. `board show` and `board list` print `project=…`. A **Project** filter next to the assignee filter keeps cards of one project (or ones with none), and board search also matches project names. Project changes made in Linear arrive with the next sync.
- **Who is working on a card.** A card without a thread of its own whose parent (or any ancestor) has a thread shows **Handled in <thread>**; clicking it opens that thread, and **Start its own thread** in its menu opens a new chat for it instead. Open cards with neither show **Needs agent**. Threads are linked to cards by the Linear Card plugin's link as well as by issue keys in branch names, and a thread is linked the moment it starts working. The other direction holds too: a thread started from, or linked to, a Linear card shows that issue in the Linear Card chip of its header, unless the chip was already unlinked or set to another issue; linking a card to a thread by hand replaces the chip's issue, and unlinking it clears the chip.
- **Card pages.** Clicking a card without a thread opens its own page (`/plugins/bb-sidebar/card/<cardId>`) instead of bb's shared new-chat screen, so back and forward walk between cards and threads, and each card keeps its own draft. The page is bb's new-thread composer seeded with the card; with the Linear Card plugin installed, its header chip shows the card's issue on the title bar (the page provides a `data-linear-card-draft` slot). Sending starts the thread already linked to the card and its Linear issue. A card in a backlog or todo column moves to the first started column (In Progress), in Linear too, when its thread is started there or when a thread linked to it starts working.
- **Child threads on board cards.** A card whose thread has children shows the same child badge as a list row (count, status dots, chevron); clicking it expands the child threads, with grandchild disclosures, under the card. Collapsed cards still show the active child and, with **Show children that need attention**, children that need you. Expansion is shared with the list view, and clicking a child row opens that thread.
- **Settle from the board.** Hovering a card whose thread can be settled shows the list's checkmark over its trailing glyphs; clicking it settles the thread (the card moves to the completed column like any settled thread). On touch screens the checkmark stays visible.
- **Archived threads leave the board.** A card without a Linear issue disappears once its thread is archived or deleted. A Linear card stays in its column but lets go of the thread: it no longer shows the thread's status, provider, children, or settle checkmark, reads **Needs agent**, and clicking it opens its card page to start a new thread. Unarchiving the thread relinks it (through its Linear Card chip) the next time it works; links missed while the plugin was off are freed on the next full Linear pass.
- **Child cards on board cards.** A card with sub-items shows a done/total badge with a chevron beside the child thread badge; clicking it expands the sub-items under the card as indented rows with their column, Linear id, and thread status. Sub-items with sub-items of their own expand the same way, and clicking a row opens that card. A sub-item is drawn only under its parent while the parent (or any ancestor) is on the board; it gets its own place in its column when the parent is filtered out, in a hidden column, or not matched by a search. A child thread that is a sub-item's own thread is listed once, as that sub-item's row. A subthread the card's agent starts for a sub-item is linked to it when its first message names that sub-item ("You own Linear TRA-123 …"); only the parent card's own sub-items are matched.
- **Board search.** A search field on the board toolbar keeps only cards whose Linear id, title, description, or thread title contains every word typed. Searching stays within the assignee filter (with **My cards** it finds only your cards; pick **Everyone** to search all) and column choices. Escape clears it.
- **Closed blockers stop blocking.** A blocker relation counts only while both cards are open: once the blocker (or the blocked card) is in a completed or canceled column, the card is no longer marked blocked, nested under it, or reported as blocked to agents. A card that is still holding others up shows **Blocking TRA-123 +n**; clicking it lists those cards, and clicking a row opens one.
- **Waiting on a machine.** A thread shows a yellow pulsing power icon instead of the working spinner (or instead of no icon) while its machine is resuming, while bb is reconnecting to it or waiting for it, and while it has queued messages behind a paused (suspending or suspended) devbox. This shows on board cards, sub-item rows, child rows, and the thread hover card, and list rows read **Resuming**. A sleeping devbox with nothing waiting on it shows nothing. The sidebar reads thread runtimes and machine lifecycles from bb every 5 seconds while the window is visible.
- **Stuck queues show as failed.** A thread that is not running (idle or failed) but still holds queued messages for 30 seconds while its machine is running shows the red failure icon on its card and rows, reads **Stuck** in list rows, and its hover card says "Stuck: queued messages are not starting". bb itself shows no status for this state. It clears as soon as the queue drains or the thread runs again.
- **Board card and Linear Card chip always agree.** Each thread's board card and the issue in its Linear Card chip are kept the same, both ways, whenever the thread starts working and on every full Linear pass: a chip set to another issue moves the board link there (when that card has no thread), otherwise the board's card is written back to the chip; unlinking the chip unlinks the card. A thread without a card is linked by its branch, a sub-item its first message names (for a card agent's subthread), or the issue on its first message's first line, in any project, so work on a trace-frontend issue that runs in the trace-backend repo still lands on its card.
- **Card threads get their own worktree.** Threads started from a card page now default to a git worktree from the project's default branch, like bb's own compose screen, instead of the shared project checkout, where two card threads failed with "Workspace is being prepared by another thread".
- **Sort by priority**: Board order, Priority (urgent first, no priority last), or Not running first, then priority (cards whose thread is idle, or that have no thread, above running ones, each group by priority) beside the board filters; blocked cards still sit under their blocker. A card moves down when its thread starts running and back up when its turn ends; opening a card does not move it.
- **Board filters.** Filter by assignee (My cards, the default; Everyone; Unassigned; or one person) and choose which columns show. Cards without a Linear issue count as yours. Linear's **Blocked** column starts hidden, since blocker relations already show what is blocked. Both choices are saved per browser. Cards created on the board are assigned to the Linear key's owner.
- **`bb bb-sidebar board …`** CLI and the agent tools `board_list_cards`, `board_get_card`, `board_create_card`, `board_update_card`, `board_set_relation`, `board_link_card`.
- **Agents claim existing cards.** `board_link_card` (e.g. `TRA-123`) makes a card the agent's own thread's card, so agents on machines where the `bb` CLI cannot reach the server (boxes.dev devboxes) can pick up an issue. It refuses a card another thread holds, and a thread that already holds a Linear card; the bare local card `"this"` makes for a thread without one is replaced.
- **Reorder Linear columns.** **Columns** in **Settings > BB Sidebar > Board** now opens for Linear-linked projects too, with up/down controls for the board's column order. The order survives syncs, states added in Linear later appear after it, and **Use Linear's order** goes back. A one-project board now reads in that order (and a local project's column order) even across categories; the merged **All projects** view still groups by category so the same stage lines up across projects.

## [0.2.26] - 2026-09-29

### Added

- Holding Cmd (Ctrl off Mac) labels the first nine rows with bb's own shortcut hints, ⌘ 1 to ⌘ 9, in place of their status. They appear on the same hold delay as bb's hints and match the row each Cmd+digit shortcut opens.
- Each process in a hover card's **Workspace ports** list has a stop button. The first click arms it; a second click within four seconds stops the process.

### Changed

- The **Workspace ports** list in a hover card starts collapsed. Click its header to show the ports.

## [0.2.25] - 2026-09-28

### Changed

- Sorting Active by project now shows each project's name once, in a header with its icon and thread count, instead of on every card. Cards under a header are a line shorter: the title sits beside the status.

### Added

- Project headers collapse. The choice is remembered, and a collapsed project still shows the open thread.

## [0.2.24] - 2026-09-27

### Fixed

- A thread's hover card no longer lists pull requests from commands that only mention `gh pr create`, such as a search of another thread's log. Only commands that run it count.

## [0.2.23] - 2026-09-27

### Added

- Hover cards have a collapsible **Pull requests** section listing every pull request a thread opened with `gh pr create`, newest first, with each PR's title and status. Before, only the PR on the thread's current branch was shown. Status comes from `gh` on the thread's machine; without it, the list still shows PR numbers and links. In a shared project checkout, a thread lists only the PRs it opened, not the checkout branch's PR.

## [0.2.22] - 2026-09-27

### Added

- A **Child threads** settings section. **Sort** orders child threads by date created or last activity, ascending or descending, in the sidebar, the thread header popup, the parent's badge, and hover cards. **Child thread icon** shows a colour circle per thread (the default) or the agent's provider icon; with provider icons, the parent's badge shows each agent once. The defaults keep the previous look and oldest-first order.

### Improved

- The child-thread tree line sits under the parent's title, and child rows sit closer to it.

### Fixed

- A slow, older settings load arriving after a newer one no longer rolls the sidebar back to the previous settings.
- The thread header's child-thread popup stays inside the window and scrolls a long list instead of running off screen.

Thanks to [@a-kras](https://github.com/a-kras) for designing and contributing the child-thread settings and the settings-load fix in [#3](https://github.com/yusuf8834/bb-sidebar/pull/3).

## [0.2.21] - 2026-09-23

### Added

- Show a spinner and "Loading threads…" while bb loads the thread list, instead of an empty list. It appears only if loading takes longer than 200 ms, so fast loads do not flicker.
- The delete confirmation now names the thread and its project, and says how many child threads go with it, so a right-click delete in a busy list cannot be mistaken for another thread. The sidebar owns this dialog and deletes through bb's SDK instead of opening bb's generic "Delete thread?" prompt.

### Fixed

- A project icon that failed to load once, for example while bb's host was still starting, no longer stays hidden until the sidebar reloads. The sidebar retries with backoff, and the server reports a read failure as temporary instead of caching it as "no icon".

## [0.2.20] - 2026-09-21

### Added

- Show every child-thread status in expanded rows: Failed, Needs you, Unread, Working or Monitoring with duration, Planning, Workflow, Agent, Command, Goal, Draft, and Drafting, using the same vocabulary as thread cards.
- Keep every child that reports a status visible while its section is collapsed, not only running ones. The "Show running children" setting is now "Show children that need attention"; its saved value carries over.

### Improved

- Child-thread rows size the status column to its label, so short statuses and ages leave more room for the title in a narrow sidebar.
- Search results give the title priority over a long project name in a narrow sidebar.
- The dark needs-you child row has a stronger tint and a leading amber edge.

### Fixed

- Status colours follow bb's theme instead of the OS colour scheme, so a dark bb on a light OS (or the reverse) no longer shows low-contrast statuses or a light needs-you band.
- On touch screens, Failed, Unread, and idle ages stay visible beside the snooze and settle actions instead of being hidden behind them.
- A woken thread shows "Woke" beside its current status in cards and search results instead of replacing it.

## [0.2.19] - 2026-09-19

### Added

- Support configurable snooze shortcuts for this evening, tomorrow morning, and next week, using local calendar times.

### Improved

- Sort parent-thread choices by recent activity in a single list.

### Fixed

- After parking or snoozing the open thread, select the first Pinned thread, then the first Active thread, or open the new-thread page when both sections are empty.

## [0.2.18] - 2026-09-19

### Improved

- Show one branch-name line in thread hover cards, using the worktree icon for worktrees and the branch icon for plain checkouts, matching the thread card.
- Add Park thread at the bottom of the snooze icon's menu.
- Reuse the section status icons for thread context-menu actions and Park thread in the snooze menu.

### Fixed

- Pinning a thread clears Settled, Snoozed, and Parked states. Settling, snoozing, or parking a thread removes its pin.

## [0.2.17] - 2026-09-18

### Added

- Add small rounded icons to Pinned, Active, Inactive, Snoozed, Parked, and Settled section headers.

### Improved

- Move Parked directly below Snoozed, before Settled.

### Fixed

- After settling the open thread, select the first Pinned thread, then the first Active thread in its current sort order, or open the new-thread page when both sections are empty.

## [0.2.16] - 2026-09-18

### Added

- Add a Parked section for threads waiting on others, with Resume, Undo, waiting age, and protection from automatic cleanup.
- Add a searchable Parent submenu for assigning or removing a thread's parent.
- Add expandable subthreads to thread hover cards.
- Offer to close thread-owned ports when settling a thread.

### Improved

- Improve drag-and-drop thread reordering and keyboard accessibility.

### Fixed

- Preserve inbox order across remounts and respect disabled inactivity settings.

## [0.2.15] - 2026-09-16

### Added

- Add Undo actions after settling, un-settling, and waking a snoozed thread.

### Removed

- Remove thread multi-selection and bulk actions.
- Remove project icon lookup through `t3.json`.

### Improved

- Shorten the README feature documentation.

## [0.2.14] - 2026-09-15

### Improved

- Add a green glow, gentle checkmark tilt, and five sparkles to the settle button, with light and dark styling, keyboard focus, and reduced-motion support.
- Keep the settle button's hit area fixed so hovering near a corner does not cause flickering.
- Remove the settle tooltip while preserving its accessible label.

## [0.2.12] - 2026-09-12

### Fixed

- Keep snooze, settle, and restore actions visible on touch devices, with parked thread labels and snooze countdowns beside the restore button.
- Group the unpin button with card actions, or with the status and Woke label when parking actions are unavailable.
- Keep the status visible when focusing Unpin on cards without parking actions.

Thanks to [@banjerluke](https://github.com/banjerluke) for contributing the touch-device fix in [#2](https://github.com/yusuf8834/bb-sidebar/pull/2).

## [0.2.11] - 2026-09-11

### Added

- Show monitoring runtimes as "Monitoring" on thread cards when BB reports that state.
- Added compact hover cards to main, child, grandchild, snoozed, and settled threads, showing project, machine, branch, provider, model, and reasoning details.
- Show project icons in hover cards when available, with a folder icon as fallback.

### Improved

- Moved thread details from the provider icon tooltip to the thread row, with support for keyboard focus.

## [0.2.10] - 2026-09-10

### Added

- Kept running child and grandchild threads visible while their child sections are collapsed. A new setting controls the behavior and is enabled by default.

### Improved

- Released thread runtimes when work is settled and closed only terminal sessions without user input, while preserving terminals the user interacted with.

## [0.2.9] - 2026-09-09

### Added

- Added a search row to the project scope card. Opening the scope picker puts the caret in a filter field above the list, so a long project list is reachable by typing, with arrow keys and Enter to pick a match.

## [0.2.8] - 2026-09-08

### Added

- Rolled child thread state up into the parent card's child badge. The badge now carries a glyph and tint for the most urgent child or grandchild: failed, needs you, done, or working, and its tooltip lists the counts.
- Highlighted the active child or grandchild row in the sidebar tree, the same way the active parent card is highlighted.

### Fixed

- Let a parent card collapse while one of its children is the active thread. A collapsed list now keeps only the active child visible, the same way a collapsed shelf keeps its active thread, and the grandchild disclosure behaves the same way.

## [0.2.7] - 2026-09-06

### Added

- Showed how long a thread has been working next to its live status, such as "Working · 5m" or "Planning · 2h". The count starts when the sidebar first sees the thread busy, survives reloads, and resets after the thread stops or asks for input.
- Added a Project submenu to thread cards with project settings, rename, local path setup, and removal with typed confirmation.
- Added Copy thread link for project and personal threads.
- Added inline rename to child and grandchild thread menus.
- Added discovery of conventional root-level project icons.

### Fixed

- Avoided pull request lookups for pinned, running, pending, snoozed, and manually overridden threads during automatic cleanup.
- Added inline validation for automatic cleanup thresholds and snooze shortcuts, including a preview of the saved snooze menu.
- Fixed styling scope for project menus and dialogs, including padding, typography, and focus rings.

### Improved

- Updated the plugin description and source comments to reflect optional sort modes.
- Documented how closed and merged pull requests participate in automatic cleanup.

## [0.2.6] - 2026-09-05

### Fixed

- Bounded the browser cache to 500 lifecycle records and 100 expanded-thread IDs to prevent unbounded storage growth.
- Recovered from storage-quota errors by evicting sidebar caches one at a time, stopping as soon as the write succeeds to preserve remaining preferences.
- Preserved expansion recency across restarts so pruning removes the oldest entries.

Thanks to [@elianiva](https://github.com/elianiva) for identifying the storage issue and contributing the fix in [#1](https://github.com/yusuf8834/bb-sidebar/pull/1).

## [0.2.5] - 2026-09-05

### Added

- Added **Regenerate title** to thread context menus. Titles use only the last three accepted user-message texts, or fewer when available.
- Added a subtle spinner beside the title during generation, shared across cards, shelves, child rows, and search results, with reduced-motion support.

### Improved

- Used bb's configured inference model and fallback through a temporary hidden helper, with cleanup after generation and protection for manual title changes.
- Kept pending threads available instead of automatically settling them.
- Aligned the development CLI with Plugin SDK 0.4.47. Requires bb 0.42.0 or later and Plugin SDK 0.4.47 or later.

## [0.2.4] - 2026-08-30

### Added

- Added project removal to plugin settings with a compact two-step confirmation and server-side checks.
- Added archive actions to child and grandchild thread menus. Archived descendants no longer appear in badges, counts, or lists.
- Added CI checks for the SDK contract, tests, type checking, and production build.

### Improved

- Kept active child and grandchild threads visible when their surrounding shelves or lists are collapsed.
- Included matching child threads in search and made lifecycle, ordering, icon, and settings refreshes resilient to stale responses.
- Kept thread-card metadata in a stable reading order.

## [0.2.3] - 2026-08-26

### Added

- Added a collapsed grandchild level to the shared header and sidebar child-thread list, with per-child counts, disclosures, status styling, and thread navigation.

### Improved

- Kept parent badges scoped to direct children while exposing one nested level beneath each child.
- Matched child-title typography between the header menu and sidebar rows.

## [0.2.2] - 2026-08-26

### Added

- Added expandable child-thread badges to parent cards, including identity colors, direct-child counts, running and attention states, and persistent inline child lists.

### Improved

- Refreshed thread card styling and tightened child-row typography.
- Updated the README screenshots to show child threads in light and dark modes.

## [0.2.1] - 2026-08-25

### Fixed

- Prevented inactive, snoozed, and settled threads from briefly appearing under Active when returning from Settings or restarting bb.

## [0.2.0] - 2026-08-24

### Added

- Added a separate Pinned shelf above Active.
- Added an optional Inactive shelf for unpinned threads without recent activity, with a configurable hour threshold.
- Added automatic project icon detection and per-project image uploads.
- Added an empty state when no active threads remain.

### Improved

- Rebuilt the plugin settings page with related controls grouped into clear sections.
- Added a native file picker and current-icon preview to the project icon settings.
- Kept Pinned, Active, Inactive, Snoozed, and Settled expansion states across reloads.

### Fixed

- Kept the settings toggle thumb inside its track in both states.

## [0.1.3] - 2026-08-24

### Added

- Added an Active sort menu with Manual order, Recent activity, Date created, and Project options.
- Added project grouping with a faint outline around projects that contain multiple active threads.

### Improved

- Preserved saved manual order when viewing activity or creation-date sorts.
- Remembered the selected Active sort mode across reloads.
- Replaced the project-grouping icon with a simpler sort icon.

### Fixed

- Removed the focus outline that remained around the sort icon after choosing an option with the pointer.

## [0.1.2] - 2026-08-24

### Fixed

- Corrected the package and plugin identity to `bb-sidebar`, matching the repository and marketplace entry.
- Rebuilt frontend styles for the `bb-sidebar` scope so hover actions load correctly after installation.
- Removed the obsolete internal product name from source comments and release notes.

## [0.1.1] - 2026-08-24

### Added

- Added a collapsible Active section that remembers its state and keeps the open thread visible.
- Added project names to Snoozed rows, matching Settled rows.

### Improved

- Tightened spacing between the Snooze and Settle hover actions.
- Increased parked-row title contrast, muted project labels, and enlarged the separator dot.

### Fixed

- Hid the extra Snooze dropdown chevron without changing menu behavior.
- Fixed plugin stylesheet scoping after the BB Sidebar rename.

## [0.1.0] - 2026-08-23

- Initial public release.

[0.2.9]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/yusuf8834/bb-sidebar/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/yusuf8834/bb-sidebar/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/yusuf8834/bb-sidebar/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/yusuf8834/bb-sidebar/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yusuf8834/bb-sidebar/releases/tag/v0.1.0

[0.2.16]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.15...v0.2.16
[0.2.17]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.16...v0.2.17
