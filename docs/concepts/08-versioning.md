# Versioning

Flygon Flow uses [Bradshaw Versioning](https://github.com/aribradshaw/devlog/blob/main/docs/bradshaw-versioning.md) numbers. Every production deploy gets the next `YEAR.MONTH.UPDATE`:

- The year is zero-based from 2026, so October 2026 is `0.10.x` and January 2027 is `1.1.x`. Months are calendar months, in the America/Phoenix timezone.
- One release per deploy. A release lists every commit the deploy brought, plus `compatibility` (`compatible`, `action-required` or `breaking`, with the required `action`).
- The server records the release when the deploy starts. Nothing is committed back to the repository.
- `public/devlog.json` is the frozen history from before deploy releases (up to `0.11.25`).

The app's Settings › DevLog and `GET /api/devlog` list every release, newest first.
