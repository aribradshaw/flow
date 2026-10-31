# Environments

An **environment** is one workspace: its charts, projects, timeline and DevOps board, plus a record of who owns it.

```json
{"id": "acme-hq", "name": "Acme HQ", "ownerEmail": "owner@example.com", "visibility": "private", "members": []}
```

- Every user starts in a new, empty, private environment. They can create more, rename them and archive them from Settings › Environment. Archiving hides an environment and keeps its data.
- **Isolation.** A private environment can only be seen by its owner and its members. Anyone else gets `404`, so the server does not even confirm that it exists. Anyone signed in can read a public environment, but only its owner can write to it.
- Every API operation that touches workspace data is scoped to one environment through the `{env}` path segment. The server runs the read or write check before it touches any data.
- Data saved before environments existed belongs to the instance's default environment.
