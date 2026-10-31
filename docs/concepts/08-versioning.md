# Versioning

Flygon Flow uses [Bradshaw Versioning](https://github.com/aribradshaw/devlog/blob/main/docs/bradshaw-versioning.md). Every commit that reaches `main` gets the next `YEAR.MONTH.UPDATE`:

- The year is zero-based from 2026, so October 2026 is `0.10.x` and January 2027 is `1.1.x`. Months are calendar months, in the America/Phoenix timezone.
- The registry is `public/devlog.json`. Each release records its version, commit, admission time and `compatibility` (`compatible`, `action-required` or `breaking`, with the required `action`), plus any verified deployments.
- A version identifies source code only. It says nothing about whether that code is deployed.

These docs are generated from the same registry, so the version in the header is the newest recorded release.
