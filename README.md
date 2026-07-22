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
them.** A success status proves the request was received, not that anything changed — roughly
30 plausible handler names "succeeded" this way while doing nothing. The real signal is in the
response body: decode `PBEditOperationResponse` and compare `originalTimestamps` to
`newTimestamps`. That oracle is what makes probing for unknown handlers tractable.

**2. Aisle/category grouping works, but not where you'd look for it.** A list doesn't own its
categories. The account owns *groupings* of categories (user-level, global); a list points at
one via **list settings**, and the server then clones that grouping's categories into the list.
The unlock is `set-category-grouping-id` on `data/list-settings/update` — not any of the
category-shaped handlers on the shopping-lists endpoint, all of which are silently ignored.

## What works

| Intent | Endpoint | handlerId |
|---|---|---|
| Create a list | shopping-lists | `new-shopping-list` |
| Delete a list | shopping-lists | `remove-shopping-list` |
| Add an item | shopping-lists | `add-shopping-list-item` |
| Set an item's category | shopping-lists | `set-list-item-category` |
| Attach a category grouping | list-settings | `set-category-grouping-id` |
| Show categories | list-settings | `set-should-hide-categories` |

Operations are protobuf messages wrapped in a list (`PBListOperationList` /
`PBListSettingsOperationList`) and POSTed as a multipart field named `operations`. They batch —
dozens of item-adds go in a single request.

`scripts/anylist-helpers.js` wraps all of this (login, user id, batching, create/delete list,
idempotent item adds) and **verifies every write**, throwing on silent failure.

```js
const al = require('./anylist-helpers');

const { any, uid } = await al.connect(__dirname);
const list = await al.ensureList(any, uid, 'Camp Grocery');
await al.addItems(any, uid, list, ['3 lb yellow onions', '2 lb carrots']);

// group it by aisle
await al.attachCategoryGrouping(any, uid, list.identifier, 'Grocery');
await al.setItemCategories(any, uid, list.identifier, {
  '3 lb yellow onions': 'produce',
  '2 lb carrots': 'produce',
});
await al.disconnect(any);
```

Adds are idempotent — re-running skips items already on the list instead of duplicating them.

**Known limit:** you can only use categories the account already has. Creating *new*
user-level categories is still unsolved (`data/user-categories/update` accepts and ignores
everything), so arbitrary section names like "Trail Food" have to be made in the app.

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
