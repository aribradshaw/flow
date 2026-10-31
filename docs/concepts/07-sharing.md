# Sharing

The owner of an environment can share part of it with another Flow user, by email: a person and everything below them, hand-picked cards, a project, a DevOps label, or the whole environment. The Share dialog (a card's **Share…** button, or Settings › Environment › *Share this environment…*) shows a live preview of exactly what the other person will see. Permissions are **view**, **comment** or **edit**.

The recipient finds it under Settings › Sharing › *Shared with you* and adds it to one of their own environments. The shared cards appear there as linked boxes with their own layout. Direct co-owners of a shared card show as read-only name stubs, and nothing else of theirs is shared. Edits travel both ways as the permission allows. Revoking a share removes everything from the recipient's environment. Recipients cannot share further; instead they ask the owner, who approves or denies the request.

The server enforces all of this: linked copies are computed from the owner's data on every read and are never stored in the recipient's environment. The API, the CLI and MCP see each environment's own data only. Details: `docs/sharing.md`.

The owner can also invite people to the app itself (Settings › Account › *Invite to Flow*). The invited person signs in with that email and gets their own empty environment.
