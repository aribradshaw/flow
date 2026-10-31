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
4. Sign in as the owner first. Flow claims that owner's app membership on the first verified sign-in. Invite other people from **Settings → Account → Invite to Flow**; each invitee signs in with the invited address and claims their own membership. Other OneProfileID accounts do not automatically gain access.

To offer **Continue with OneProfileID** for passkeys and existing OneProfileID browser sessions, ask the operator for a separate OneProfileID SSO client registered with `https://your-origin.example/api/auth/sso/callback`. Set both `OPID_SSO_CLIENT_ID` and `OPID_SSO_CLIENT_SECRET` (32+ characters). `OPID_SSO_ISSUER` optionally overrides the default OneProfileID issuer. These settings add the OneProfileID passkey route; native email/password sign-in works without them.

`RESEND_API_KEY` and `FLOW_EMAIL_FROM` optionally deliver invitation emails. Invites can still be created without email delivery; share the invitation details yourself. Back up the persistent volume or Postgres database, and test restoring a Save snapshot before depending on the instance for important work.
