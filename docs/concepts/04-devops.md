# DevOps board and gates

The DevOps board is a card board. Each card has an auto-incrementing `#number`.

Columns, in order: `requests` (Requests / Sprinted, where new cards land), `doing`, `blocked`, `uat`, `done`, then the two backlogs `must` (Must Have) and `nice` (Nice to Have).

A card holds `title, description, column, project, labels[], points, due, assignees[{node, role}], checklist[{text, done}], links[{kind, url}], item` and the `created` / `updated` / `moved` timestamps. Assignee roles are `developer`, `tester` and `requester`, and each assignee is a person card on the chart. Link kinds are `pr`, `commit` and `url`. `item` links the card to a timeline item. Responses also list `agents`, the AgentFlow agents the card is delegated to (see AgentFlow: delegation and the work queue).

## Gates

Some moves need a confirmation or a decision. The app asks for it, and API callers must provide it explicitly:

| Move | Gate |
| --- | --- |
| UAT → Done with **Approve** | none (approval is the gate) |
| anything else → `done` | `confirm-done` |
| `done` → anything | `confirm-reopen` (reopen) |
| → `doing` with no developer | `pick-dev`: choose who develops it |

Labels have a section (`priority`, `urgency`, `area`, `topic`, `other`) and a colour key. Due dates turn amber two days before they are due and red once they are overdue.

## Board order and column sorts

Board order is the order of the cards in the board (`cards.list` returns it); dragging a card within a column changes it. In the app, each column header has a sort menu: Manual (board order), newest or oldest first, recently updated, due date, points, priority (Urgency labels, then Priority labels, in the order they are listed) or card number and title. A sort is a view for one person: it is kept in their preferences, never in the workspace, and it does not change the board order or any card. Cards missing the sorted value (no due date, no points, no priority label) go last, and ties keep board order. Reordering inside a sorted column is refused until it is back on Manual; moving a card into a sorted column puts it at the end of the board order.
