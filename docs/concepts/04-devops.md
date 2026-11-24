# DevOps board and gates

The DevOps board is a card board. Each card has an auto-incrementing `#number`.

Columns, in order: `requests` (Requests / Sprinted, where new cards land), `doing`, `blocked`, `uat`, `done`, then the two backlogs `must` (Must Have) and `nice` (Nice to Have).

A card holds `title, description, column, project, labels[], points, actual, due, assignees[{node, role}], checklist[{text, done}], links[{kind, url}], item` and the `created` / `updated` / `moved` timestamps. Assignee roles are `developer`, `tester` and `requester`, and each assignee is a person card on the chart. Link kinds are `pr`, `commit` and `url`. `item` links the card to a timeline item. `points` is the estimate made up front and `actual` the points the card actually took, recorded after the work (for example from the agents' token use); both are a number from 0 to 1000 or null, and setting one never changes the other. Responses also list `agents`, the AgentFlow agents the card is delegated to (see AgentFlow: delegation and the work queue).

## Gates

Some moves need a confirmation or a decision. The app asks for it, and API callers must provide it explicitly:

| Move | Gate |
| --- | --- |
| UAT → Done with **Approve** | none (approval is the gate) |
| anything else → `done` | `confirm-done` |
| `done` → anything | `confirm-reopen` (reopen) |
| → `doing` with no developer | `pick-dev`: choose who develops it |

Labels have a section (`priority`, `urgency`, `area`, `topic`, `other`) and a colour key. Due dates turn amber two days before they are due and red once they are overdue.

## Recently deleted

Every card that leaves the board is recorded on the server first, whatever removed it: **Delete** on the board, undo or redo, a snapshot restore or other whole-workspace save from a browser, or the API and MCP. The record holds the whole card as it was, who removed it (`deletedBy`; `via`: `board`, `undo`, `snapshot`, `save` for a tab running older code, `api`, `mcp`; and `actor`, the API key's name), when, the last revision it was in (`fromRev`) and the environment. Records are kept for 180 days, apart from the revision history, so a card can be restored long after its revision has rolled off.

`cards.deleted` lists them, newest first (`q`: `#12` or title text; `pending: true` leaves out restored ones). `cards.restore` puts one back with the same id, column, fields and agent links. It keeps its number unless another card has taken it; then it gets the next number, `renumbered` is `true` and `message` says so. In the app, the ↺ button in the board's toolbar opens **Recently deleted**, with a Restore button per card.

A save that removes cards without a Delete (an undo, a restored snapshot) still goes through, so the other changes in it are not lost; the answer lists them as `removedCards`, and the app says they can be restored from Recently deleted. A save from an older revision is refused with `409` as before, and the browser merges it, which keeps cards added meanwhile.

## Snoozing cards

A card can be snoozed until a time: the clock button on the card (shown on hover or focus) or its right-click menu offers In 1 hour, In 3 hours, Tomorrow (9:00 AM), Next week (Monday 9:00 AM) and Custom… (a date and time), each with the time it lands on. The snooze is the card's, stored as `snoozedUntil` (an ISO time) and the same for everyone on the board. Until then the card is left out of its column; the clock in the column header shows how many cards there are snoozed and shows or hides them (dimmed, with their wake time), remembered per column for each person. The toolbar's card count leaves snoozed cards out; when any are snoozed, a clock beside it shows how many and shows or hides them in every column at once. An agent's work queue (`agents.work`) leaves them out too. When the time passes the card is a normal card again, with no job on the server: the board works it out from the time. Moving a snoozed card keeps its snooze. Through the API and MCP, `cards.update` takes `snoozedUntil` (an ISO time, or `""` / `null` to wake it; a past time wakes it too), `cards.get` and `cards.list` return it (`null` when awake), and `cards.list` takes `snoozed: true` or `false` to keep only snoozed or only awake cards.

## Board order and column sorts

Board order is the order of the cards in the board (`cards.list` returns it); dragging a card within a column changes it. In the app, each column header has a sort menu: Manual (board order), newest or oldest first, recently updated, due date, points, actual points, priority (Urgency labels, then Priority labels, in the order they are listed) or card number and title. A sort is a view for one person: it is kept in their preferences, never in the workspace, and it does not change the board order or any card. Cards missing the sorted value (no due date, no points, no actual points, no priority label) go last, and ties keep board order. Reordering inside a sorted column is refused until it is back on Manual; moving a card into a sorted column puts it at the end of the board order.
