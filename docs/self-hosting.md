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

Public listening requires OneProfileID. Register the instance with OneProfileID and set `OPID_BASE_URL`, `OPID_APP_ID`, `OPID_APP_SECRET` (32+ characters), and `OPID_APP_ORIGIN` together. Set `OWNER_EMAIL` to the owner account. The server refuses a public `HOST` without OneProfileID configured.

Provide persistent storage directories or Postgres before inviting users. `RESEND_API_KEY` and `FLOW_EMAIL_FROM` optionally deliver invitation emails; invitations can still be created without them.

Use HTTPS for the public origin. Back up the persistent volume or Postgres database, and test restoring a Save snapshot before depending on the instance for important work.
