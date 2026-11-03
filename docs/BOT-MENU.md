# Bot menu configuration

The Bridge receives bot-menu taps from Feishu through the raw
`application.bot.menu_v6` event. Menu entries carry an `event_key`; the
`onBotMenu` handler in `src/bot/handle-message.ts` routes a small allow-list of
keys to existing cards, and the new `runtime.*` keys to plain text replies.

Bot menus only work in **private chat (p2p)**. Group messages do not show the
pinned menu. Admin gating is unchanged: non-admins receive a refusal text before
any routing happens.

## Native setup (developer console)

1. Open the Feishu/Lark developer console for the app used by the Bridge.
2. Enable the bot capability and find the bot custom-menu (机器人自定义菜单)
   settings.
3. Add menu items of type **push event** (推送事件). Set each item's
   `event_key` to one of the exact values below. Labels are free-form.
4. Under event subscriptions / 事件与回调, subscribe
   `application.bot.menu_v6` in long-connection mode. This is the same optional
   event the Bridge already reports in `doctor`; without it, menu taps are
   silently absent.
5. Publish an app version. Menu changes take effect only after release.

The console may limit how many menu items can be configured. Configure the keys
you need; if a slot count is limited, prioritize `runtime.accounts`,
`runtime.status`, `runtime.usage`, then the existing DM entries. Any key that is
not routed, or an empty key, falls back to the normal DM home menu card.

Bridge does **not** call an API to create or edit menus. No menu configuration
route is invented here, and this repository does not ship a menu JSON artifact
because no stable schema is established for one. The developer console is the
source of truth.

## Existing `dm.*` keys

These are the exact action ids exported as `DM` in `src/card/dm-cards.ts`.

| Key | Used by |
| --- | --- |
| `dm.menu` | DM home menu card |
| `dm.newProject` | Bot menu → new-project form |
| `dm.newProject.submit` | New-project form submit |
| `dm.joinGroup.submit` | Join-group form submit |
| `dm.projects` | Bot menu → project list |
| `dm.settings` | Bot menu → settings card |
| `dm.voice.settings` | Voice settings card |
| `dm.voice.set` | Voice setting change |
| `dm.voice.test` | Voice test |
| `dm.voice.refreshPermission` | Refresh voice permission |
| `dm.coffee.settings` | Coffee/away settings |
| `dm.doctor` | Bot menu → doctor card |
| `dm.reconnect` | Bot menu → reconnect card |
| `dm.restart` | Restart confirmation card |
| `dm.restart.do` | Confirmed restart |
| `dm.update` | Bot menu → update check card |
| `dm.update.do` | Confirmed update install |
| `dm.usage` | Bot menu → usage card |
| `dm.usage.refresh` | Refresh usage |
| `dm.usage.share` | Usage share picker |
| `dm.usage.share.do` | Generate usage share card |
| `dm.rmConfirm` | Remove-project confirmation |
| `dm.rmDo` | Confirmed project removal |
| `dm.rmCancel` | Cancel project removal |
| `dm.set.tools` | Show/hide tool calls |
| `dm.set.showModel` | Show/hide model label |
| `dm.set.watchdog` | Watchdog timeout |
| `dm.set.watchdog.custom` | Custom watchdog form |
| `dm.set.watchdog.customSubmit` | Custom watchdog submit |
| `dm.set.completionReminder` | Completion-reminder mode |
| `dm.set.completionReminder.custom` | Custom reminder form |
| `dm.set.completionReminder.customSubmit` | Custom reminder submit |
| `dm.set.pending` | Pending-message policy |
| `dm.set.concurrency` | Max concurrent runs |
| `dm.admins` | Admin list |
| `dm.admin.addForm` | Add-admin form |
| `dm.admin.addSubmit` | Add-admin submit |
| `dm.admin.rm` | Remove admin |
| `dm.allowlist` | User allowlist |
| `dm.allow.addForm` | Add allowed-user form |
| `dm.allow.addSubmit` | Add allowed-user submit |
| `dm.allow.rm` | Remove allowed user |
| `dm.projectSettings` | Project settings container |
| `dm.projectTopics` | Project topic drill-down |
| `dm.proj.noMention` | Project no-mention toggle |
| `dm.proj.autoCompact` | Project auto-compact toggle |
| `dm.proj.modelDefault` | Default model/intensity |
| `dm.proj.modelDefault.submit` | Default model submit |
| `dm.proj.perm` | Permission form |
| `dm.proj.perm.submit` | Permission submit |
| `dm.comment.settings` | Comment settings |
| `dm.comment.setBackend` | Comment backend picker |
| `dm.comment.submit` | Comment settings submit |
| `dm.comment.editPrompt` | Edit comment prompt |
| `dm.comment.promptSubmit` | Comment prompt submit |
| `dm.comment.resetPrompt` | Reset comment prompt |
| `dm.sessionTitle.settings` | Session-title settings |
| `dm.sessionTitle.setBackend` | Session-title backend |
| `dm.sessionTitle.submit` | Session-title submit |
| `dm.sessionTitle.disable` | Disable session titles |

Only the `dm.newProject`, `dm.projects`, `dm.settings`, `dm.doctor`,
`dm.reconnect`, `dm.restart`, `dm.usage` and `dm.update` keys are currently
routed as bot-menu entries. The rest are card action ids and remain reachable
from their cards; an unlisted menu key falls back to the home menu card.

## New `runtime.*` keys

| Key | Behavior |
| --- | --- |
| `runtime.accounts` | Read-only account list. Explains the explicit `/runtime switch <short-id-or-account-id>` command and that only codex-switch-managed accounts are shown. Never switches. |
| `runtime.status` | Read-only current-auth/managed-account status. Never switches. |
| `runtime.usage` | Read-only `usage --all` summary. Never switches. |

All three send plain text to the operator's `open_id`; there is no card or
frontend redesign. They are handled after the existing admin check in
`onBotMenu`. If the Bridge is busy with an account transition, the menu reports
that instead of reading data.

Switching is intentionally **not** a menu action. The menu can only explain and
list; the admin must send the explicit `/runtime switch` command in private
chat.
