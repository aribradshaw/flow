# Flow for iPhone and iPad

The app is in `apps/ios` (SwiftUI, iOS 18). The board, cards, the inbox and the widgets are native. The mind map, timeline, AgentFlow and the 3D office are the web app, already signed in. To build and run it, see `apps/ios/README.md`.

## What it does

- **Board:** every column, filtered by project, in one environment at a time. You can create cards, edit them (title, description, project, labels, points, due date, checklist, links) and move them. The board's checks apply: confirm Done, Approve from UAT, Reopen.
- **Inbox:** everything waiting on you. That means your agents waiting on a decision (Allow, Deny or a reply), additions waiting on your approval, share requests, and the cards assigned to you across your environments, with UAT first.
- **Notifications:** one of your agents starts waiting (you can answer from the lock screen), a card is assigned to you, or a card assigned to you changes column. You don't get a notification for changes you made yourself. Do not disturb in the office holds agent notifications. Each kind can be turned off in the app's Settings.
- **Widgets:** "Waiting on you" and "Doing" on the home screen, plus a count on the lock screen.

## How the app signs in

The app signs in with the web app's own routes (OneProfileID, or email and password) and then makes itself an API key with the `device` scope. Only a signed-in person can make a key with that scope. The key appears under Settings › Connect, where you can revoke it. The native views use it with `/api/v1`.

The app's own routes accept only device keys. An agent's ordinary key (MCP, the CLI, the office bridge) is refused there, so an agent can never approve its own permission prompt or read your inbox:

| Route | What it does |
| --- | --- |
| `GET /api/app/inbox` | `{agents, cards, push}`: your waiting agents and the cards assigned to you |
| `POST /api/app/agents/answer` | `{source, agentId, requestId, decision}` (allow or deny), or `{source, agentId, kind:'message', text}` |
| `PUT /api/app/devices` | `{token, environment, bundle, prefs:{agents, cards}}` registers this device for notifications |
| `DELETE /api/app/devices` | `{token}` |

A device belongs to the key that registered it. Once that key is revoked or expires, the device gets nothing more and is forgotten. To turn notifications on for a server, see "Push notifications" in [Self-host Flow](self-hosting.md).

"Me" on a card means a person card with your email or linked to your OneProfileID account, or you as a share member.
