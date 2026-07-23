---
name: anylist
description: Read, create, populate, delete, and category-group lists in AnyList — the user's shared grocery/shopping list app (groceries, camping, packing, to-do). Use for any request mentioning AnyList in any casing, whatever else the request involves: adding items; turning a recipe, PDF, doc, spreadsheet, meal plan, or trip plan into a list there; creating or deleting a list; reading back, counting, exporting, or de-duplicating a list; grouping or sorting items by aisle or category; scripting a recurring sync. This applies even when generating or parsing the content is most of the work — if the result lands in AnyList, use this skill. It carries the only working access path: AnyList has no public API, so the auth, the reverse-engineered protocol, the helper script, and the check for writes the server silently discards all live here. Skip it only for troubleshooting the AnyList phone or desktop app itself, or list-making that never touches AnyList.
---

# AnyList automation

Drive an AnyList account from Node. AnyList has no public API, so this uses the unofficial
`anylist` npm package plus undocumented protobuf operations discovered by reverse-engineering
the desktop app.

Read **Telling a real write from a silent no-op** before anything else. AnyList returns
`HTTP 200` for operations it doesn't recognize and discards them. Without the success oracle
below you will confidently report writes that never happened.

## Setup

```bash
npm install anylist
```

Credentials go in a gitignored `.env` beside your script (never print them):

```
ANYLIST_EMAIL=you@example.com
ANYLIST_PASSWORD=...
```

Check whether a working AnyList project already exists locally before scaffolding a new one.

`scripts/anylist-helpers.js` wraps everything here — login, uid, batched operations,
create/delete list, idempotent adds, category grouping, and the success oracle. Copy it next
to your script and `require` it rather than rebuilding the protobuf plumbing.

## What the library gives you, and what it doesn't

`anylist` handles auth and reading, plus adding/updating items on existing lists:
`getLists()`, `getListByName()`, `createItem()`, `list.addItem()`.

It cannot create a list, delete a list, or touch categories — those need raw operations. Two
quirks:

- The library never sets `this.uid`, so it sends `userId: undefined`. Writes still work
  (auth comes from the Bearer token), but for raw operations get the real id from the JWT
  access token's `sub` claim.
- `item._encode()` omits category fields, so the library can't express categorization.

## The operation model

Mutations are protobuf operations wrapped in a list and POSTed as a multipart field named
`operations`. Three endpoints matter:

| Endpoint | Wrapper | Used for |
|---|---|---|
| `data/shopping-lists/update` | `PBListOperationList` | lists, items, item categories |
| `data/list-settings/update` | `PBListSettingsOperationList` | attaching a list to a category set |
| `data/user-categories/all` | — (read) | the account's categories + groupings |

```js
const ops = new any.protobuf.PBListOperationList();
ops.setOperations([op1, op2, /* ... */]);
const form = new FormData();
form.append('operations', ops.toBuffer());
await any.client.post('data/shopping-lists/update', { body: form });
```

Batch freely — 60 item-adds in one POST is fine and far faster than 60 round trips.

### Confirmed handlers

| Intent | Endpoint | handlerId | Op fields |
|---|---|---|---|
| Create list | shopping-lists | `new-shopping-list` | `listId`, `list` |
| Delete list | shopping-lists | `remove-shopping-list` | `listId`, `list` |
| Add item | shopping-lists | `add-shopping-list-item` | `listId`, `listItemId`, `listItem` |
| Set item category | shopping-lists | `set-list-item-category` | `listId`, `listItemId`, `updatedValue` |
| Set item category assignment | shopping-lists | `update-list-item-category-assignment` | `listId`, `listItemId`, `listItem` (carrying `categoryAssignments`) |
| Attach category set | list-settings | `set-category-grouping-id` | `updatedSettings` |
| Show categories | list-settings | `set-should-hide-categories` | `updatedSettings` |

Timestamps are seconds (`Date.now() / 1000`); identifiers come from
`require('anylist/lib/uuid')` (32-char, dashless).

## Telling a real write from a silent no-op

An unrecognized `handlerId` returns `HTTP 200` and changes nothing. Status codes are useless
as a success signal — this is the single biggest trap in this API.

The reliable oracle is the response body. Decode it as `PBEditOperationResponse` and compare
`originalTimestamps` to `newTimestamps` — a real operation bumps them:

```js
const r = any.protobuf.PBEditOperationResponse.decode(res.body);
const changed = JSON.stringify(r.originalTimestamps) !== JSON.stringify(r.newTimestamps);
// changed === false  =>  the server ignored your operation
```

Use `changed` and nothing else. In particular **`processedOperations` is not a success
signal** — the server echoes your operation ids back in it even for handlers it doesn't
recognize, so a non-empty list there means only that it read your request.

The helper's `postOps()` returns `{ status, changed, processed }`. This makes probing for
unknown handlers tractable — try a candidate, read `changed`. It also beats diffing full
state, which is slow and, on a shared account, racy.

Still verify important writes by re-fetching and asserting on **your own identifiers**.

## Categories and aisle grouping

This works, but not the way you'd guess. Categories are user-level: the account owns a set of
categories organized into named *groupings* (typically a "Grocery" grouping holding the ~21
standard supermarket aisles). A list doesn't own categories — it points at a grouping, and the
**server clones that grouping's categories into the list**.

A brand-new list starts with a category group containing only `Other`, so items can't group
until you attach a grouping. The sequence:

1. Read the account's groupings from `data/user-categories/all` (`PBUserCategoryData`) and
   pick one (usually the "Grocery" set).
2. `set-category-grouping-id` on `data/list-settings/update`, with
   `updatedSettings.categoryGroupingId` = that grouping's identifier. The server then clones
   all its categories into this list's group.
3. `set-should-hide-categories` (same endpoint) with `shouldHideCategories = false`.
4. Per item, on `data/shopping-lists/update`, write **both** representations — they are not
   equivalent and app-made items carry both:
   - `set-list-item-category` with `updatedValue` = a **system category id** (sets
     `ListItem.category` and `categoryMatchId`)
   - `update-list-item-category-assignment` with `op.listItem` = a `ListItem` carrying
     `categoryAssignments: [{ categoryGroupId, categoryId }]`, where `categoryId` is the
     category's id **in this list's own group** (not the user-level category id)

   This works on items that already exist — no need to delete and re-add them.

Common system category ids:

```
produce  dairy  meat  seafood  deli  bakery  beverages  frozen-foods
snacks-cookies-and-candy   soups-and-canned-goods   cooking-and-baking
condiments-oils-and-salad-dressings   breakfast-and-cereal
grains-pasta-and-side-dishes   household-and-cleaning
health-and-personal-care   pet-supplies   baby   wine-beer-spirits   other
```

`scripts/anylist-helpers.js` exposes this as `attachCategoryGrouping()` and
`setItemCategories()`.

### Limits worth stating plainly

- **This reuses categories the account already has.** Creating *new* user-level categories is
  unsolved — writes to `data/user-categories/update` are silently ignored. If the user wants
  section names that don't exist (e.g. "Trail Food", "Fuel and Cleanup"), you can't create
  them via the API. Map to the closest existing aisle, or tell them that specific naming has
  to be done in the app. Don't quietly substitute different names without saying so.
- **Never write to `data/user-categories/update`.** That data is global and shared by every
  list on the account; the recipe above never needs it.
- **Preserve existing fields when writing `PBListSettings`.** The message carries unrelated
  settings, and sending it with unset scalars resets `listColorType`, `listThemeId`, and
  `listItemSortOrder` to defaults and can blank `listCategoryGroupId`. Read current settings
  first and carry them through. The settings live in `listSettingsResponse.**settings**` —
  there is no `newSettings` field, and reading that name returns empty for every list, which
  looks exactly like "this list has no settings" and will send you down a wrong path.
- Verification here is of AnyList's **server-side data**, not the rendered app. Items end up
  structurally identical to ones categorized in the app, which is strong evidence, but if you
  haven't opened the app, say that rather than promising the UI looks right.

## Working safely

Experiment on a throwaway list, then delete it with `remove-shopping-list` and confirm it's
gone. Accounts accumulate lists fast.

**Match list names exactly** (`l.name === name`). Real lists sit right next to test ones — an
account with a `Backpacking` list will also match `Backpacking Test Run` under any
`includes()`-style comparison, and you'll write into real data.

**Don't use account-wide totals as a guardrail.** "List count went up by one" breaks the
moment anything else touches the account (another script, the phone app, a second agent).
Assert on the identifiers you created.

Prefer idempotent writes: look up the list by name and reuse it, and skip items already
present. The helper does both. Note this de-duplicates but doesn't reconcile — renaming an
item in the app means the next run re-adds the original name, and removing an item from your
source array won't remove it from the list.

For bulk imports, mirror the source faithfully — keeping `6 dozen eggs (Fri and Sat)` as one
item name preserves quantity and note together, which is more useful when shopping than an
over-parsed guess. Report counts back and check them against the source.

## Further reference

`references/protocol.md` — endpoint map, protobuf message shapes, the JWT/uid detail, the
category model in depth, and the handler-discovery technique (including which strings in the
app bundle are *not* handler ids). Read it before protocol-level work.
