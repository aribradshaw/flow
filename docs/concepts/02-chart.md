# Chart

The chart is a free-form canvas of **cards** joined by **edges**. A workspace can hold several charts; one of them is active.

- Card types: `entity` (a company or organisation), `person`, `area` (a project area that groups cards inside it) and `note`.
- Edge types: `ownership` is a solid arrow that can carry a percentage from 0 to 100, or `""` when the percentage is unknown. `group` is a dashed line that means grouping only.
- Cards snap to a 16px grid and can be resized. Moving an area also moves every card that sits fully inside it.
- Selecting an entity or area shows its **project strip**: the projects placed under it, their next timeline item, backlog counts and open DevOps cards.

```json
{"id": "c1", "name": "Acme · structure",
 "nodes": [{"id": "acme", "name": "Acme Holdings", "type": "entity", "x": 400, "y": 0},
           {"id": "rivera", "name": "Sam Rivera", "type": "person", "x": 320, "y": 144}],
 "edges": [{"id": "o1", "from": "rivera", "to": "acme", "type": "ownership", "percent": "60"}]}
```

Validation is strict: ids must be unique, every edge must join two existing cards, and a card cannot connect to itself.
