# MindMap (charts)

The app's **MindMap** tab is a free-form canvas of **cards** joined by **edges**. The API calls each mind map a **chart** (`charts.list`, `nodes.*`, `edges.*`). A workspace can hold several charts; one of them is active. In the app, right-clicking a card, a connection or empty canvas opens a menu of the actions that apply there.

- Card types: `entity` (a company or organisation), `person`, `area` (a project area that groups cards inside it) and `note`.
- Edge types: `ownership` is a solid arrow that can carry a percentage from 0 to 100, or `""` when the percentage is unknown. `group` is a dashed line that means grouping only.
- Cards snap to a 16px grid and can be resized. Moving an area also moves every card that sits fully inside it.
- A `person` card can have a **photo** (`image`: an `https://` URL, or a `data:image/png|jpeg|webp;base64,` URL of at most 61,440 characters) and an **email** (`email`, up to 200 characters, stored lower-case). In the app, the person's side panel can upload a photo (cropped to a 128px square), remove it, or **Use my photo** to take your account photo and email. A person whose email is yours shows your account photo until they get one of their own. The photo then appears wherever that person does: their card, DevOps assignee bubbles, pickers and AgentFlow supervisor badges. Invalid values, and photos or emails on other card types, are dropped.
- Sharing a person shares their photo with whoever can see the card, but never their email.
- Selecting an entity or area shows its **project strip**: the projects placed under it, their next timeline item, backlog counts and open DevOps cards.

```json
{"id": "c1", "name": "Acme · structure",
 "nodes": [{"id": "acme", "name": "Acme Holdings", "type": "entity", "x": 400, "y": 0},
           {"id": "rivera", "name": "Sam Rivera", "type": "person", "x": 320, "y": 144}],
 "edges": [{"id": "o1", "from": "rivera", "to": "acme", "type": "ownership", "percent": "60"}]}
```

Validation is strict: ids must be unique, every edge must join two existing cards, and a card cannot connect to itself.
