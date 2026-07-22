# AnyList skill

A [Claude Code](https://claude.com/claude-code) skill for driving [AnyList](https://www.anylist.com/)
programmatically — creating lists, bulk-importing items, and reading account data — plus a
written-up reverse-engineering of the parts of AnyList's private API that matter.

AnyList has no public API. This builds on the unofficial
[`anylist`](https://www.npmjs.com/package/anylist) npm package and adds the undocumented
operations that package doesn't cover.

## Why this exists

Two findings here cost real time to establish and are the reason this is worth publishing:

**1. AnyList returns `HTTP 200` for operations it doesn't recognize, then silently discards
them.** A success status proves the request was received, not that anything changed. Roughly 30
plausible handler names were tried before this became obvious. Every write must be verified by
re-fetching state and diffing — which also makes probing for unknown handlers tractable.

**2. Creating categories / grouping items via the API does not work.** Modern AnyList accounts
use a *user-level* category system: categories are global to the account, not per-list, and
drive every list that uses them. Reads work; every write attempt across the category endpoints
is accepted and dropped. `references/protocol.md` documents exactly what was tried so nobody
repeats it. Grouping has to be done in the AnyList app.

## What works

| Intent | handlerId |
|---|---|
| Create a list | `new-shopping-list` |
| Delete a list | `remove-shopping-list` |
| Add an item | `add-shopping-list-item` |

Operations are protobuf `PBListOperation` messages wrapped in a `PBListOperationList` and
POSTed as a multipart field named `operations` to `data/shopping-lists/update`. They batch —
dozens of item-adds go in a single request.

`scripts/anylist-helpers.js` wraps all of this (login, user id, batching, create/delete list,
idempotent item adds) and **verifies every write**, throwing on silent failure.

```js
const al = require('./anylist-helpers');

const { any, uid } = await al.connect(__dirname);
const list = await al.ensureList(any, uid, 'Camp Grocery');
await al.addItems(any, uid, list, ['3 lb yellow onions', '2 lb carrots']);
await al.disconnect(any);
```

Adds are idempotent — re-running skips items already on the list instead of duplicating them.

## Install

As a Claude Code skill:

```bash
git clone https://github.com/chadsaun/anylist-skill ~/.claude/skills/anylist
```

To use the helper directly, `npm install anylist` and put credentials in a gitignored `.env`:

```
ANYLIST_EMAIL=you@example.com
ANYLIST_PASSWORD=...
```

## Contents

- `SKILL.md` — the skill: setup, working operations, the traps, and how to work safely
- `references/protocol.md` — endpoint map, protobuf message shapes, the JWT/user-id detail,
  and the full log of what was tried and rejected for categories
- `scripts/anylist-helpers.js` — reusable, self-verifying Node helpers

## Caveats

Unofficial and unaffiliated with AnyList. It depends on a private API that can change without
notice, so treat the handler names as findings rather than guarantees — and re-verify with the
probe-and-refetch approach described in the skill if something stops working. Do experiments on
a throwaway list; category data in particular is global and shared, so malformed writes there
risk affecting existing lists.

## License

MIT
