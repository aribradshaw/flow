# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use **Security › Report a vulnerability** on this repository to contact the maintainers privately.

Include what you found, how to reproduce it, and what an attacker could do with it. We aim to acknowledge reports within 3 business days and to keep you updated until a fix ships. Please give us reasonable time to fix the problem before you disclose it publicly. We are glad to credit you.

## Scope

In scope: this repository's server (`server.mjs`, `lib/`), the browser app (`public/`), the API, the MCP server, the CLI and the tools in `tools/`.

The following are **out of scope**:
- Testing against a production instance you do not own without permission. Run your own instance instead (`npm start`).
- Denial of service, spam and social engineering.
- Problems in OneProfileID itself. Report those to its maintainers.

## Supported versions

Only the latest release on `main` gets security fixes. Versions are listed in `public/devlog.json` (Settings › DevLog in the app).

## Handling secrets

- API keys (`flow_…`) are personal and scoped. Revoke one in Settings if it leaks.
- `.env` is never committed. CI runs without secrets.
- Report any secret you find in this repository's history through the private channel above.
