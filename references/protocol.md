# AnyList protocol reference

Everything here was established empirically against a live account using the `anylist` npm
package (v0.8.6) as the transport. Read the "Categories" section before attempting any
category work — it is a documented dead end, not an unexplored area.

## Contents

- [Auth and user id](#auth-and-user-id)
- [Endpoint map](#endpoint-map)
- [Operation envelope](#operation-envelope)
- [Confirmed handlers](#confirmed-handlers)
- [Protobuf message shapes](#protobuf-message-shapes)
- [Categories: what was tried and why it failed](#categories-what-was-tried-and-why-it-failed)
- [Discovering handler names](#discovering-handler-names)

## Auth and user id

`login()` POSTs email/password to `auth/token` and stores `access_token` / `refresh_token`.
Requests carry `Authorization: Bearer <token>` and `X-AnyLeaf-API-Version: 3`.

The library never assigns `this.uid`, so `List` and `Item` send `userId: undefined` in
operation metadata. Writes still succeed because the server identifies the user from the
token. When building raw operations, decode the real id from the JWT payload's **`sub`**
claim (a 32-char dashless hex string). Other plausible fields (`user_id`, `uid`) are absent.

Tokens are cached in `~/.anylist_credentials` by default.

## Endpoint map

Extracted from the desktop app's cached JS bundle. Only a few were exercised.

| Endpoint | Purpose | Status |
|---|---|---|
| `data/user-data/get` | Full account snapshot (lists, items, category groups) | works (read) |
| `data/shopping-lists/update` | All list + item operations | works (write) |
| `data/shopping-lists/all` | Lists | not exercised |
| `data/user-categories/all` | Global categories + groupings | works (read) |
| `data/user-categories/update` | Category/grouping writes | accepts, never persists |
| `data/categorized-items/all` \| `/update` | Item→category placements | writes never persist |
| `data/list-settings/update`, `data/starter-lists/update`, `data/list-folders/update`, `data/recipes/*`, `data/meal-planning-calendar/*` | other subsystems | not exercised |

`data/shopping-list-category-groups/update` and `data/shopping-list-categories/update` return
**403** — they do not exist. (Contrast with the 200-and-ignore behavior of real endpoints.)

## Operation envelope

List mutations are `PBListOperation` messages wrapped in a `PBListOperationList` and POSTed
as a multipart form field named `operations`:

```js
const ops = new any.protobuf.PBListOperationList();
ops.setOperations([op, ...]);           // batching is supported and fast
const form = new FormData();
form.append('operations', ops.toBuffer());
await any.client.post('data/shopping-lists/update', { body: form });
```

Other subsystems use the same shape with their own wrapper type — `PBUserCategoryOperationList`
for `user-categories/update`, `PBCategorizeItemOperationList` for `categorized-items/update`.
Both accept the request and discard it.

**A 200 response does not mean the operation was applied.** Unrecognized handlers are accepted
and dropped. Always re-fetch and diff.

## Confirmed handlers

Verified by write-then-refetch:

| handlerId | Effect | Op fields |
|---|---|---|
| `new-shopping-list` | creates a list | `listId`, `list` |
| `remove-shopping-list` | deletes a list | `listId`, `list` |
| `add-shopping-list-item` | adds an item | `listId`, `listItemId`, `listItem` |

Used by the library and assumed good: `remove-shopping-list-item`, `set-list-item-name`,
`set-list-item-details`, `set-list-item-quantity`, `set-list-item-checked`,
`set-list-item-sort-order`, `uncheck-all`.

`set-list-item-category-match-id` exists and returns 200, but setting a match id whose category
isn't already in the list's group does not stick — the field comes back empty.

## Protobuf message shapes

Field numbers omitted where irrelevant. Access messages as `any.protobuf.<Name>`; note the
list-level ones are **not** `PB`-prefixed.

```
ShoppingList          identifier(required), timestamp(double, seconds), name, items[],
                      creator, sharedUsers[], logicalClockTime(uint64),
                      listItemSortOrder, newListItemPosition
                      — NOTE: no categoryGroupId field

ListItem              identifier(required), listId, name, details, checked, category,
                      categoryMatchId, categoryAssignments[], quantityPb{amount},
                      manualSortIndex, userId

PBListOperation       metadata, listId, listItemId, updatedValue, originalValue,
                      listItem, list, updatedCategory, updatedCategoryGroup,
                      updatedCategorizationRule, ...

PBOperationMetadata   operationId, handlerId, userId, operationClass(int32),
                      operationVersion(int32)
                      — operationClass/Version are never set by the library and are the
                        prime suspects for why category ops are rejected

PBListCategory        identifier, categoryGroupId, listId, name, icon, systemCategory,
                      sortIndex, logicalTimestamp
PBListCategoryGroup   identifier, listId, name, categories[], defaultCategoryId,
                      logicalTimestamp, categoriesLogicalTimestamp

PBUserCategory        identifier, userId, name, icon, systemCategory, categoryMatchId,
                      fromSharedList, timestamp
PBCategoryGrouping    identifier, userId, name, timestamp, sharingId, categoryIds[]
PBUserCategoryData    identifier, timestamp, categories[], groupings[]
PBUserCategoryOperation      metadata, category, grouping
PBCategorizeItemOperation    metadata, listItem
```

Identifiers are 32-char dashless hex (`require('anylist/lib/uuid')`). Timestamps are seconds
(`Date.now() / 1000`). `logicalClockTime` is a per-list monotonic counter maintained server-side.

## Categories: what was tried and why it failed

### How categorization actually works on this account

Categories are **global to the user**, not per-list. `data/user-categories/all` returns a
`PBUserCategoryData` holding all categories plus named groupings — typically a "Grocery"
grouping carrying the ~21 standard supermarket aisles, alongside any custom ones the user has
made. A list is associated with a grouping, and the
server projects that into the per-list `categoryGroupResponses` seen in `user-data/get`.
Item placement lives in the separate `categorized-items` subsystem.

Note the id indirection: a user category (say Produce) has one id in `PBUserCategoryData` and
a *different* id in a given list's projected category group. Any write path has to get that
translation right.

### Facts that mislead

- **Every new list already has a category group** containing exactly one category, `Other`.
  A group appearing after your write is the default, not your doing. Match on your own
  identifier, and prefer diffing full state over checking existence.
- **API-added items are never auto-categorized.** Items named "Bananas", "Milk", "Bread" all
  come back with `categoryMatchId = null`. Auto-categorization is a client-side feature of the
  apps, so it only applies to items added through them.

### What was attempted

All returned HTTP 200 and persisted nothing:

- `updatedCategoryGroup` / `updatedCategory` on `data/shopping-lists/update` under ~20 handler
  names (`new-list-category-group`, `set-list-category-group`, `create-category-group`,
  `create-category`, `add-category`, and `new-`/`add-`/`set-`/`update-`/`save-` ×
  `list-category`/`shopping-list-category`/`category-group` permutations)
- The same, targeting the **existing** default group's identifier rather than a fresh one
- The same, with `logicalTimestamp` / `categoriesLogicalTimestamp` set to the list's
  `logicalClockTime + 1`
- `PBUserCategoryOperation{grouping}` with `create-category-group` on
  `data/user-categories/update` — including reusing existing category ids so no new global
  categories would be created
- `set-list-category-group-id` (list op, grouping id in `updatedValue`)
- `PBCategorizeItemOperation{listItem with categoryAssignments}` on
  `data/categorized-items/update` under `update-list-item-category-assignment`
- `set-list-item-category-match-id` with a system category value

Dedicated category endpoints (`shopping-list-category-groups/update`,
`shopping-list-categories/update`) return 403 — they don't exist.

### Conclusion

The most likely missing piece is the `operationClass` / `operationVersion` discriminator in
`PBOperationMetadata`, which the library never sets and whose values aren't recoverable from
the minified bundle. Cracking it would require deeper reverse-engineering (deobfuscating the
app bundle or intercepting TLS from the native app).

**Don't grind on this against the live account.** Category data is global and shared, so
malformed writes risk corrupting categorization on existing lists. Grouping should be done in
the AnyList app, which orchestrates these subsystems correctly. When a user asks for grouping,
say so directly and offer an item → category mapping they can apply, rather than silently
delivering something weaker.

## Discovering handler names

The macOS app is WebKit-based and caches the web app's JS bundle, which contains the handler
and endpoint vocabulary:

```bash
CACHE="$HOME/Library/Caches/com.purplecover.anylist.mac/WebKit/NetworkCache"
grep -rhaoE "data/[a-z-]+/[a-z-]+" "$CACHE" | sort -u                 # endpoints
grep -rhaoE "[a-z][a-z0-9-]*categor[a-z0-9-]*" "$CACHE" | sort -u     # topic search
perl -0777 -ne 'while(/setHandlerId\("([^"]+)"\)/gs){print "$1\n"}' "$BLOB" | sort -u
```

The main app binary itself yields nothing — `strings` finds no handler literals.

**Caveat that cost real time:** dashed strings in the bundle are not necessarily server
handlerIds. Most `setHandlerId` calls take a variable, and many dashed strings are client-side
action or screen names. `create-category-group` looks exactly like a handler and isn't one.
Treat every string as a candidate and confirm by probe-and-refetch on a throwaway list.
