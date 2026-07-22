---
name: anylist
description: Programmatically read, create, and populate lists in AnyList (groceries, camping, packing, to-do lists) via the reverse-engineered AnyList API. Use whenever the user wants to get items into or out of AnyList — "add this to my AnyList", "make a grocery list from this recipe/PDF", "create a packing list in AnyList", "what's on my AnyList", importing a list from a document, or syncing items to AnyList. Also use before attempting anything involving AnyList categories, because this skill documents which operations actually work and which silently fail.
---

# AnyList automation

Drive an AnyList account from Node. AnyList has no public API, so this uses the unofficial
`anylist` npm package plus a handful of undocumented protobuf operations that were discovered
by reverse-engineering the desktop app.

The single most important thing to internalize is in **The silent-200 trap** below. AnyList's
server accepts unknown operations with `HTTP 200` and then does nothing. If you skip
verification you will confidently report success on writes that never happened.

## Setup

```bash
npm install anylist
```

Credentials go in a gitignored `.env` beside your script (never print them):

```
ANYLIST_EMAIL=you@example.com
ANYLIST_PASSWORD=...
```

Check whether a working AnyList project already exists locally before creating a new one —
reusing it saves re-installing and re-entering credentials.

`scripts/anylist-helpers.js` in this skill folder wraps everything below (login, uid, batched
operations, create/delete list, idempotent item adds, verification). Copy it next to your
script and `require` it instead of rebuilding the protobuf plumbing by hand.

## What the library gives you, and what it doesn't

`anylist` handles auth and reading, plus adding/updating items on lists that already exist:
`getLists()`, `getListByName()`, `createItem()`, `list.addItem()`.

It has **no** way to create a list, delete a list, or touch categories. Those need raw
operations (below). Two quirks worth knowing:

- The library never sets `this.uid`, so `List`/`Item` send `userId: undefined`. Writes still
  work because auth comes from the Bearer token — but when you build raw operations, get the
  real id from the JWT access token's `sub` claim.
- `item._encode()` omits `categoryAssignments`, so the library cannot express item
  categorization even if the server would accept it.

## The operation model

Every list mutation is a `PBListOperation` carrying a `handlerId`, wrapped in a
`PBListOperationList`, POSTed as a multipart field named `operations`:

```js
const ops = new any.protobuf.PBListOperationList();
ops.setOperations([op1, op2, /* ... */]);
const form = new FormData();
form.append('operations', ops.toBuffer());
await any.client.post('data/shopping-lists/update', { body: form });
```

Batch freely — 60 item-adds in one POST is fine and much faster than 60 round trips.

### Handlers that are confirmed working

| Intent | handlerId | Fields to set on the op |
|---|---|---|
| Create list | `new-shopping-list` | `listId`, `list` = `ShoppingList{identifier, name, timestamp, creator}` |
| Delete list | `remove-shopping-list` | `listId`, `list` = `ShoppingList{identifier, name, timestamp}` |
| Add item | `add-shopping-list-item` | `listId`, `listItemId`, `listItem` = `ListItem{identifier, listId, name}` |

Set `timestamp` as seconds (`Date.now() / 1000`) and use the library's
`require('anylist/lib/uuid')` for identifiers (32-char, dashless).

## The silent-200 trap

**AnyList returns `HTTP 200` for operations it does not recognize, and silently discards
them.** A 200 means "request received", not "change applied". This is how ~30 plausible
handler names were burned through before noticing.

So never treat a status code as success. After any write, re-fetch and assert the change is
actually present:

```js
await createList(any, name, uid);
const lists = await any.getLists();          // refetch
if (!lists.some(l => l.name === name)) throw new Error('list not created');
```

The helper script does this for you and throws on silent failure. When you're hunting for a
new handler, the same rule makes probing tractable: try a candidate, refetch, diff the state.
Anything that doesn't change state is the wrong name, no matter what it returns.

## Categories: a documented dead end

**Do not try to create categories or group items via the API.** This was investigated
thoroughly and it does not work. Read `references/protocol.md` before spending any time here.

The short version: current accounts use AnyList's newer **user-level category** system.
Categories are not per-list — they live globally on the account (organized into named
groupings like "Grocery") and drive *every* list that uses them. A list points at a grouping;
item placements live in a separate `categorized-items` subsystem.

Reading that data works fine (`data/user-categories/all` → `PBUserCategoryData`). Writing does
not: every create/assign attempt across the category endpoints returns 200 and persists
nothing, apparently because the server validates an operation-class/version handshake that
isn't recoverable from the client bundle.

Two facts that trip people up:

- Every newly created list already has a default category group containing exactly one
  category, `Other`. Seeing a group appear is not evidence your write worked.
- AnyList does **not** auto-categorize items added via the API. Even clean names like
  "Bananas" / "Milk" / "Bread" come back with `categoryMatchId = null`. Auto-categorization is
  client-side, so it only happens for items added through the app.

Because category data is global and shared, trial-and-error writes risk scrambling
categorization on existing lists — a long-lived grocery list can hold thousands of items. If
the user wants grouping, say plainly that it has to be done in the AnyList app, and offer to
produce an item → category mapping they can apply. Don't quietly substitute a worse result —
sorting items so sections cluster together is a reasonable fallback, but name it as a fallback.

## Discovering new handlers

The macOS desktop app is WebKit-based and its cached JS bundle contains the handler vocabulary:

```bash
CACHE="$HOME/Library/Caches/com.purplecover.anylist.mac/WebKit/NetworkCache"
grep -rhaoE "[a-z][a-z0-9-]*categor[a-z0-9-]*" "$CACHE" | sort -u        # topic search
grep -rhaoE "data/[a-z-]+/[a-z-]+" "$CACHE" | sort -u                    # endpoint map
```

Important caveat learned the hard way: **not every dashed string in that bundle is a server
handlerId.** Many are client-side action names. `create-category-group` reads like a handler
and is not one. Treat anything found this way as a candidate, then confirm it by
probe-and-refetch on a throwaway list. Cheap to verify, expensive to assume.

## Working safely

Experiments belong on a throwaway list, not a real one. Create it, test, delete it with
`remove-shopping-list`, and confirm it's gone — accounts accumulate lists quickly and clutter
is easy to leave behind.

Prefer idempotent writes so a re-run can't duplicate: look up the list by name and reuse it if
it exists, and skip items whose name already appears in the list. The helper script does both.

For a bulk import, mirror the source faithfully — keeping a full line like
`6 dozen eggs (Fri and Sat)` as the item name preserves the quantity and note in one field,
which is more useful when shopping than an over-parsed guess. Report counts back to the user
and verify them against the source.

## Further reference

`references/protocol.md` — endpoint map, protobuf message shapes (`ShoppingList`, `ListItem`,
`PBListOperation`, the user-category messages), the JWT/uid detail, and the full log of what
was tried and rejected for categories. Read it before any protocol-level work.
