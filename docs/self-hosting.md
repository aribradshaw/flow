# Self-host Flow

Flow needs Node.js 22 or newer. For a personal installation, clone the repository, run `npm ci && npm start`, and open the printed loopback URL. No account or external service is required. Data is saved in your browser and in local files; use the app's Save action for a portable snapshot.

## Configure

Copy `.env.example` to `.env` and uncomment only the settings you need. The server reads `.env` at startup. Keep `.env` out of version control.

- `PORT` sets the listening port. Without it, local mode starts at 4317 and chooses the next free port.
- `FLOW_LOCAL_NAME` and `FLOW_LOCAL_EMAIL` set the local identity.
- `BACKUP_DIR`, `SAVES_DIR`, and `INBOX_DIR` set persistent storage paths. Mount a persistent volume at those paths when running in a container.
- `DATABASE_URL` adds Postgres storage for cloud saves, workspaces, sessions, and preferences. Set `DATABASE_SSL=1` for verified TLS. Local file storage works without Postgres.
- `FLOW_INSTANCE_NAME` changes the browser title and header tooltip. `FLOW_ACCENT_COLOR` accepts a six-digit hex color for green highlight elements; other theme colors stay at their defaults. `FLOW_LOGO_PATH` is a same-origin path to an SVG, PNG, or WebP file placed under `public/`.

## Host for other users

Public listening requires OneProfileID. At present, a OneProfileID operator must provision a **native app registration** for your instance. The OneProfileID developer integration request does not automatically issue a native app ID or secret. Hosted multi-user setup is therefore available to instances with an approved native registration; anyone can still run Flow locally without an account or registration.

Once you have that registration:

1. Give the operator your intended HTTPS origin and confirm that it is allowed for the native app. Keep the issued app secret on the server.
2. Set `OPID_BASE_URL` to the native service origin, `OPID_APP_ID` and `OPID_APP_SECRET` to the issued native credentials, and `OPID_APP_ORIGIN` to your exact public origin. Set all four together; the secret must be at least 32 characters. Set `OWNER_EMAIL` to the verified OneProfileID address that should own the instance.
3. Mount persistent storage for `BACKUP_DIR`, `SAVES_DIR`, and `INBOX_DIR` before inviting users. Optionally set `DATABASE_URL` for cloud saves, workspaces, sessions, and preferences; it does not replace the local backup and inbox directories. Serve the app over HTTPS and start it with `npm start`. The server refuses a public `HOST` when OneProfileID is not configured.
4. Sign in as the owner first. Flow claims that owner's app membership on the first verified sign-in.
5. Choose who may join. With open sign-up (`FLOW_OPEN_SIGNUP`, on by default) any verified OneProfileID account can join: on its first sign-in Flow claims a membership of its own for that person (never `owner`), and they start in a private **My workspace**. This needs the native registration to allow self-enrollment (`allowSelfEnrollment`, plus `allowProvisioning` or `allowMembershipClaims`); until the operator turns that on, new people see that Flow is invite-only and can ask to be told when they can join. Once `FLOW_MAX_USERS` people have joined, new sign-ups see "Flow is full right now" instead, with the same request. The owner sees requests in **Settings → Account → Invite to Flow**, and owner invites are let in even when Flow is full. Set `FLOW_OPEN_SIGNUP=off` to accept invited people only.
6. Removing someone. The owner removes a member in **Settings → Account → People in Flow** (or revokes an invite that was already used, or runs `node tools/env.mjs remove <email>`). Flow records the removal, revokes the membership on OneProfileID with the app secret (`/membership/revoke`, after Flow's own owner check), ends that person's Flow sessions and turns off their API keys, so the API, MCP and the CLI stop working for them too. Their charts are kept. A removed person who signs in sees that the owner removed the account; only a new invite brings them back. Flow also follows OneProfileID's `/membership/events` every `FLOW_MEMBERSHIP_POLL_SECONDS` (default 60; `0` turns it off) and applies revocations made there the same way; the last event it saw is kept in Postgres (`flygon_flow_state`) or `BACKUP_DIR/_membership-cursor.json`. This needs the native registration to allow invitations or membership claims.

To offer **Continue with OneProfileID** for passkeys and existing OneProfileID browser sessions, ask the operator for a separate OneProfileID SSO client registered with `https://your-origin.example/api/auth/sso/callback`. Set both `OPID_SSO_CLIENT_ID` and `OPID_SSO_CLIENT_SECRET` (32+ characters). `OPID_SSO_ISSUER` optionally overrides the default OneProfileID issuer. These settings add the OneProfileID passkey route; native email/password sign-in works without them.

With the SSO client set, the sign-in screen says what Flow is and who can join, and has one main button that goes to OneProfileID, where people sign in or make an account. A sign-in transaction lasts 30 minutes, so making an account on the way fits, and one that still runs out starts again once by itself. If a sign-in is refused (Flow is full or invite-only) or interrupted, the screen names the OneProfileID account signed in on that browser and offers the next step: ask to be told when there is room, try again, or use a different account. "Use a different account" (also in the account menu) starts sign-in again with `prompt=select_account`, so OneProfileID asks "Continue as …" or lets the person pick another account. When Flow knows the email (an invite link's address, or the account a refused sign-in used), it is sent as `login_hint` and pre-fills OneProfileID's sign-in and sign-up; it can be changed there. `OPID_ACCOUNT_URL` is the OneProfileID account page linked from the sign-in screen (default `https://auth.oneprofileid.com/dashboard`). New people start with a choice: an example workspace (fictional data) or a blank one, with a hint on the empty canvas.

Under **Other ways to sign in**, the screen also offers **Sign in with your phone** for screens that cannot use passkeys, such as kiosk web views: it shows a QR code and a short code, the person approves on their phone with a passkey, and the screen signs in. It uses the OAuth device flow with the same SSO client, so the operator must enable device sign-in for that client. The screen starts on this option when the browser has no passkey support (no `PublicKeyCredential`), its user agent contains `Saguaro`, or the page was once opened with `?saguaro=1`. Set `OPID_DEVICE_SIGN_IN=off` to turn it off.

`RESEND_API_KEY` and `FLOW_EMAIL_FROM` optionally deliver invitation emails. `FLOW_EMAIL_FROM` is a sender on a domain verified in Resend, for example `Flygon Flow <flow@flygonlc.com>`. The invite is laid out by [OneMail](https://github.com/aribradshaw/onemail): its header logo is `/email/flow-logo@2x.png` from your instance's public URL, so it shows only when that URL is https; otherwise the header is the name as text. Invites can still be created without email delivery; share the invitation details yourself. Back up the persistent volume or Postgres database, and test restoring a Save snapshot before depending on the instance for important work.

## Deploy on Railway

For a Flow service backed by Postgres, set these values in Railway:

| Service setting | Value |
| --- | --- |
| Healthcheck Path | `/health` |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | `300` |
| `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` | `5` |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` |

Flow starts listening after it initializes office storage. Railway waits for the healthcheck before switching traffic. On SIGTERM, Flow asks office streams to reconnect after 500 ms and gives active HTTP requests up to 25 seconds to finish. Railway services with an attached volume can still have a short interruption while the volume moves to the new deployment. See Railway's [healthchecks](https://docs.railway.com/deployments/healthchecks) and [deployment teardown](https://docs.railway.com/deployments/deployment-teardown).

Use the same `DATABASE_URL` for both deployments. Reconnecting viewers get the saved reports, chat, status and actions in their snapshot. When a reporter and a viewer are routed to different deployments during overlap, live agent updates, chat, replies and avatar movement can appear delayed until the viewer reconnects. Postgres prevents both deployments from claiming the same action. The file fallback requires a single process and a persistent `BACKUP_DIR`.

For users in the southwestern United States, use **US West Metal (California)**, `us-west2`, for both the Flow service and its database when possible. See [Railway regions](https://docs.railway.com/deployments/regions).

## Limits

A Flow that other people can join keeps each person within limits, so one account cannot fill the server. The owner (`OWNER_EMAIL`) has larger limits and no environment or storage cap. Set any of these to change them; the defaults are in brackets.

| Setting | Applies to | Default |
|---|---|---|
| `FLOW_MAX_ENVIRONMENTS` | environments one person owns (archived ones excluded) | 5 |
| `FLOW_MAX_WORKSPACE_BYTES` / `FLOW_OWNER_MAX_WORKSPACE_BYTES` | one saved workspace | 2 MB / 5 MB |
| `FLOW_HISTORY_KEEP` / `FLOW_OWNER_HISTORY_KEEP` | revisions kept per workspace | 20 / 100 |
| `FLOW_MAX_API_KEYS` / `FLOW_OWNER_MAX_API_KEYS` | active API keys per person | 5 / 50 |
| `FLOW_MAX_USER_BYTES` | everything one person stores, archived environments included | 25 MB |
| `FLOW_MAX_ITEMS` / `FLOW_OWNER_MAX_ITEMS` | cards, nodes, edges, projects, timeline items, agents and workflows in one workspace | 20,000 / 100,000 |
| `FLOW_MAX_SAVES` | Save snapshots kept per person (the owner keeps 200) | 20 |
| `FLOW_MAX_USERS` | people who may join; after that, new sign-ups see "Flow is full right now" and can ask to be told when there is room | 500 |
| `FLOW_PUBLIC_AFTER_DAYS` | days before a new account may make an environment public | 7 |
| `FLOW_MEMBER_INVITES_PER_WEEK` | invites one member may send in a rolling week (the owner: no limit) | 5 |
| `FLOW_MEMBERSHIP_POLL_SECONDS` | how often Flow checks OneProfileID for membership revocations made elsewhere (`0`: never) | 60 |
| `FLOW_AUTH_RATE_IP` / `FLOW_AUTH_RATE_USER` | sign-in requests per minute per client address / per person | 30 / 10 |

- A save over a limit is refused with a message that says which limit, and nothing is changed. A save that makes a workspace smaller always goes through, so someone over a limit can delete things.
- Invite email limits (20 an hour per sender, 3 an hour per recipient) and member invite quotas are kept in Postgres (`flygon_flow_rate_events`), or a file beside the backups, so a deploy does not reset them.
- Disk backups (`BACKUP_DIR`) are kept for the owner only; everyone's workspace is on the server with its revision history.
- Public environments open by their link (id) for anyone signed in, but are never listed to other people.
- AgentFlow: a card last changed by someone outside the environment (through an edit share) is left out of `agents.work` until the owner changes it again in Flow, so text from outside never starts a runner by itself. Runners use the owner's API key for one environment, and a member's key never reaches the owner's environments.
- A public instance (OneProfileID on https) does not start without `OWNER_EMAIL`.

## Voice and screen sharing

The 3D office's meeting room, proximity voice and screen sharing connect browsers directly with WebRTC. Your server only relays the set-up messages. By default browsers find their public address with Google's public STUN server (`stun:stun.l.google.com:19302`). That is enough when at least one side has an ordinary home router. Some networks cannot be reached directly: carrier-grade NAT on mobile and some ISPs, strict corporate firewalls, and two symmetric NATs. Calls between those need a TURN relay, so set one up if your users are on such networks.

- `OFFICE_STUN_URLS`: comma-separated STUN URLs that replace the default. Use `none` for no STUN.
- `OFFICE_TURN_URLS`, `OFFICE_TURN_USERNAME`, `OFFICE_TURN_CREDENTIAL`: your own TURN server (for example coturn), such as `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349`. The username and credential are sent to signed-in members of an office, so use an account that can only relay.
- `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_KEY_API_TOKEN`: [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/). Create a TURN key in the Cloudflare dashboard (Realtime › TURN). Flow then fetches short-lived credentials (6 hours) for each person on the server. Only those credentials reach browsers, never the key ID or API token, and URLs on port 53 (which browsers block) are dropped. If Cloudflare cannot be reached, calls fall back to STUN.

Browsers allow the microphone and screen capture only on HTTPS pages (or `localhost`). When Flow is embedded in another site, the embedding page's frame needs `allow="microphone; display-capture"`. Restart the server after changing these settings.

## Embed Flow in another site

By default Flow refuses to be shown inside another site's frame (`Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`), which protects against clickjacking. To show Flow in a dashboard, a home-screen app or a kiosk, list the sites that may embed it in `FLOW_FRAME_ANCESTORS`, separated by spaces or commas:

```sh
FLOW_FRAME_ANCESTORS="http://127.0.0.1:8770 https://dashboard.example.ts.net"
```

- Each entry is a bare origin: scheme, host and an optional port, with no path or wildcard. Use the exact address the embedding page is opened at; `http://localhost:8770` and `http://127.0.0.1:8770` are different origins. An invalid entry stops the server at startup.
- Flow then sends `frame-ancestors 'self'` plus those origins and leaves out `X-Frame-Options`.
- On an https instance with sign-in, Flow's sign-in cookies switch to `SameSite=None; Secure` so the framed app stays signed in. Browsers that block third-party cookies still do; sign in from the frame's own **Open in new tab** link or allow cookies for your Flow origin. Local single-user mode has no sign-in cookies.
- Leave the variable unset to keep embedding off. Restart the server after changing it.

Embedding only controls where Flow may appear. People still sign in to Flow, and API keys work the same way.
