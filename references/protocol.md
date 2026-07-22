# AnyList protocol reference

Established empirically against a live account using the `anylist` npm package (v0.8.6) as the
transport. Where something is unverified it says so.

## Contents

- [Auth and user id](#auth-and-user-id)
- [Endpoint map](#endpoint-map)
- [Operation envelope](#operation-envelope)
- [The success oracle](#the-success-oracle)
- [Confirmed handlers](#confirmed-handlers)
- [Protobuf message shapes](#protobuf-message-shapes)
- [The category model](#the-category-model)
- [Still unsolved](#still-unsolved)
- [Discovering handler names](#discovering-handler-names)

## Auth and user id

`login()` POSTs email/password to `auth/token` and stores `access_token` / `refresh_token`.
Requests carry `Authorization: Bearer <token>` and `X-AnyLeaf-API-Version: 3`.

The library never assigns `this.uid`, so `List` and `Item` send `userId: undefined` in
operation metadata. Writes still succeed because the server identifies the user from the token.
For raw operations, decode the real id from the JWT payload's **`sub`** claim (32-char dashless
hex). Other plausible fields (`user_id`, `uid`) are absent. Tokens cache in
`~/.anylist_credentials`.

## Endpoint map

Extracted from the desktop app's cached JS bundle; exercised ones marked.

| Endpoint | Purpose | Status |
|---|---|---|
| `data/user-data/get` | Full account snapshot (lists, items, category groups, list settings) | works (read) |
| `data/shopping-lists/update` | List, item, and item-category operations | works (write) |
| `data/list-settings/update` | Per-list settings, incl. attaching a category grouping | works (write) |
| `data/user-categories/all` | Global categories + groupings | works (read) |
| `data/user-categories/update` | Category/grouping writes | accepts, never persists |
| `data/categorized-items/all` \| `/update` | Remembered item→category placements | writes never persist |
| `data/starter-lists/update`, `data/list-folders/update`, `data/recipes/*`, `data/meal-planning-calendar/*` | other subsystems | not exercised |

`data/shopping-list-category-groups/update` and `data/shopping-list-categories/update` return
**403** — they don't exist (contrast with the 200-and-ignore behavior of real endpoints).

## Operation envelope

Operations are protobuf messages wrapped in a list and POSTed as a multipart form field named
`operations`. The wrapper type depends on the endpoint:

| Endpoint | Wrapper | Operation |
|---|---|---|
| `data/shopping-lists/update` | `PBListOperationList` | `PBListOperation` |
| `data/list-settings/update` | `PBListSettingsOperationList` | `PBListSettingsOperation` |

```js
const ops = new any.protobuf.PBListOperationList();
ops.setOperations([op, ...]);            // batching supported and fast
const form = new FormData();
form.append('operations', ops.toBuffer());
await any.client.post('data/shopping-lists/update', { body: form });
```

## The success oracle

**A 200 response does not mean the operation was applied.** Unrecognized handlers are accepted
and dropped. The response body is what tells you:

```js
const r = any.protobuf.PBEditOperationResponse.decode(res.body);
const changed = JSON.stringify(r.originalTimestamps) !== JSON.stringify(r.newTimestamps);
const processed = (r.processedOperations || []).length;
```

`changed === false` means the server ignored you. This is the tool that makes handler-name
probing tractable; without it, every wrong guess looks like a success. It's also cheaper and
less racy than diffing full account state, which shifts under you when anything else (the
phone app, another script) touches the account.

**`processedOperations` is not a success signal.** The server echoes submitted operation ids
back in it even for handlers that don't exist — a bogus `handlerId` returns 200 with a body
structurally identical to a real one's. Only the timestamp comparison discriminates.

## Confirmed handlers

Verified by oracle + refetch:

| handlerId | Endpoint | Effect | Op fields |
|---|---|---|---|
| `new-shopping-list` | shopping-lists | creates a list | `listId`, `list` |
| `remove-shopping-list` | shopping-lists | deletes a list | `listId`, `list` |
| `add-shopping-list-item` | shopping-lists | adds an item | `listId`, `listItemId`, `listItem` |
| `set-list-item-category` | shopping-lists | sets item category (writes both `category` and `categoryMatchId`) | `listId`, `listItemId`, `updatedValue` |
| `update-list-item-category-assignment` | shopping-lists | sets `categoryAssignments` on an existing item | `listId`, `listItemId`, `listItem` (carrying the assignment) |
| `set-category-grouping-id` | list-settings | attaches list to a user category grouping; server clones its categories into the list | `updatedSettings` |
| `set-should-hide-categories` | list-settings | toggles category display | `updatedSettings` |

Used by the library and assumed good: `remove-shopping-list-item`, `set-list-item-name`,
`set-list-item-details`, `set-list-item-quantity`, `set-list-item-checked`,
`set-list-item-sort-order`, `uncheck-all`.

`set-list-item-category-match-id` exists and returns 200, but setting a match id whose category
isn't on the list doesn't stick. Use `set-list-item-category` instead.

## Protobuf message shapes

Field numbers omitted where irrelevant. Access as `any.protobuf.<Name>`; list-level messages
are **not** `PB`-prefixed.

```
ShoppingList          identifier(required), timestamp(double, seconds), name, items[],
                      creator, sharedUsers[], logicalClockTime(uint64),
                      listItemSortOrder, newListItemPosition
                      — NOTE: no categoryGroupId; that lives in PBListSettings

ListItem              identifier(required), listId, name, details, checked, category,
                      categoryMatchId, categoryAssignments[], quantityPb{amount},
                      manualSortIndex, userId

PBListOperation       metadata, listId, listItemId, updatedValue, originalValue,
                      listItem, list, updatedCategory, updatedCategoryGroup, ...
PBOperationMetadata   operationId, handlerId, userId, operationClass, operationVersion

PBListSettings        identifier, userId, listId, timestamp, listCategoryGroupId,
                      categoryGroupingId, shouldHideCategories, listColorType,
                      listThemeId, listItemSortOrder, ...
PBListSettingsOperation      metadata, updatedSettings

PBListCategory        identifier, categoryGroupId, listId, name, icon, systemCategory,
                      sortIndex, logicalTimestamp
PBListCategoryGroup   identifier, listId, name, categories[], defaultCategoryId

PBUserCategory        identifier, userId, name, icon, systemCategory, categoryMatchId
PBCategoryGrouping    identifier, userId, name, timestamp, sharingId, categoryIds[]
PBUserCategoryData    identifier, timestamp, categories[], groupings[]

PBEditOperationResponse  originalTimestamps[], newTimestamps[], processedOperations[], ...
```

Identifiers: 32-char dashless hex (`require('anylist/lib/uuid')`). Timestamps: seconds.

## The category model

Three layers, and confusing them is what makes this hard:

1. **User level (global).** The account owns categories and named *groupings*
   (`PBUserCategoryData` from `data/user-categories/all`) — typically a "Grocery" grouping
   holding the ~21 standard aisles, plus any custom ones. Shared by every list. **Read-only in
   practice** — writes to `data/user-categories/update` are silently ignored.
2. **List level.** Each list has its own `PBListCategoryGroup`, which is a *server-made copy*
   of a user grouping. `PBListSettings.categoryGroupingId` records which user grouping it came
   from; `listCategoryGroupId` points at the copy. A new list starts with a group containing
   only `Other`.
3. **Item level.** `ListItem.category` / `categoryMatchId` hold a *system category id* string
   (`produce`, `dairy`, …). `categoryAssignments[]` holds explicit group→category id pairs.

### The working sequence

```
1. read groupings         GET-ish  data/user-categories/all  -> pick e.g. "Grocery"
2. attach grouping        POST     data/list-settings/update  set-category-grouping-id
                                   updatedSettings.categoryGroupingId = grouping.identifier
   -> server clones all 21 categories into this list's own category group
3. show categories        POST     data/list-settings/update  set-should-hide-categories (false)
4. categorize each item   POST     data/shopping-lists/update set-list-item-category
                                   op.listItemId + op.updatedValue = 'produce' | 'dairy' | ...
```

Reproduced from scratch on a clean throwaway list: group went 1 → 21 categories and all items
came back with `category`/`categoryMatchId` set.

System category ids seen on real data:

```
produce  dairy  meat  seafood  deli  bakery  beverages  frozen-foods  refrigerated
snacks-cookies-and-candy   soups-and-canned-goods   cooking-and-baking
condiments-oils-and-salad-dressings   breakfast-and-cereal
grains-pasta-and-side-dishes   household-and-cleaning   health-and-personal-care
pet-supplies   baby   wine-beer-spirits   other
```

### Gotchas

- **`PBListSettings` carries unrelated settings.** Writing it with unset scalars resets
  `listColorType`, `listThemeId`, `listItemSortOrder` to defaults and can blank
  `listCategoryGroupId`. Read current settings and carry the fields through.
- **Write both category representations.** `set-list-item-category` sets the legacy
  `category`/`categoryMatchId` pair but does *not* create a `categoryAssignments` entry, which
  is what app-categorized items carry. Use `update-list-item-category-assignment` as well; it
  works on existing items (no delete/re-add needed). The `categoryId` in the assignment is the
  category's id **in this list's cloned group**, not the user-level category id.
- **Settings live in `listSettingsResponse.settings`.** There is no `newSettings` field —
  reading that name yields 0 rows for every list on the account (actual: one row per list) and
  makes correctly-configured lists look unconfigured.
- **AnyList does not auto-categorize API-added items.** Items named "Bananas"/"Milk"/"Bread"
  come back with `categoryMatchId = null`. Auto-categorization is client-side.
- **Never write to `data/user-categories/update`** — global, shared, and ignored anyway.
- Verification is of the server-side data model, not the app's rendering. Items end up
  structurally identical to app-categorized ones, which is strong evidence but not a pixel
  check.

## Still unsolved

- **Creating new user-level categories or groupings.** Writes to `data/user-categories/update`
  (with `PBUserCategoryOperation{category|grouping}` under `create-category`,
  `create-category-group`, and ~20 name variants) return 200 and persist nothing. So you can
  only reuse category names the account already has. Arbitrary section names (e.g. "Trail
  Food") aren't creatable via the API — do that in the app.
- The likely blocker is the `operationClass` / `operationVersion` discriminator in
  `PBOperationMetadata`, which the library never sets and whose values aren't recoverable from
  the minified bundle.

Previously listed here and since **solved**: setting `categoryAssignments` on an existing item.
The handler name (`update-list-item-category-assignment`) was right but the endpoint was wrong
— it belongs on `data/shopping-lists/update` with the assignment carried on the operation's
nested `listItem`, not on `data/categorized-items/update`. Worth remembering as a pattern: a
handler that appears dead may just be pointed at the wrong endpoint.

## Discovering handler names

The macOS app is WebKit-based and caches the web app's JS bundle, which holds the handler and
endpoint vocabulary:

```bash
CACHE="$HOME/Library/Caches/com.purplecover.anylist.mac/WebKit/NetworkCache"
grep -rhaoE "data/[a-z-]+/[a-z-]+" "$CACHE" | sort -u                 # endpoints
grep -rhaoE "[a-z][a-z0-9-]*categor[a-z0-9-]*" "$CACHE" | sort -u     # topic search
```

The main app binary yields nothing — `strings` finds no handler literals.

**Caveat that cost real time:** dashed strings in the bundle are not necessarily server
handlerIds. Most `setHandlerId` calls take a variable, and many dashed strings are client-side
action or screen names — `create-category-group` looks exactly like a handler and isn't one,
while the real one (`set-category-grouping-id`) lives on a different endpoint entirely. Treat
every string as a candidate and confirm with the oracle on a throwaway list.
