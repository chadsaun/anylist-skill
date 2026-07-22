// Reusable helpers for the AnyList API.
//
// AnyList returns HTTP 200 for operations it doesn't recognize and silently discards them,
// so every post here decodes PBEditOperationResponse and reports whether the server actually
// changed anything (`changed`). Writes are additionally verified by re-fetching state.
//
// Usage:
//   const al = require('./anylist-helpers');
//   const { any, uid } = await al.connect(__dirname);
//   const list = await al.ensureList(any, uid, 'Camp Grocery');
//   await al.addItems(any, uid, list, ['3 lb yellow onions', '2 lb carrots']);
//   await al.attachCategoryGrouping(any, uid, list.identifier, 'Grocery');
//   await al.setItemCategories(any, uid, list.identifier, { '3 lb yellow onions': 'produce' });
//   await al.disconnect(any);

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const AnyList = require('anylist');
const uuid = require('anylist/lib/uuid');

const LIST_ENDPOINT = 'data/shopping-lists/update';
const SETTINGS_ENDPOINT = 'data/list-settings/update';

/** Load .env into process.env without ever printing values. */
function loadEnv(dir) {
  const p = path.join(dir, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

/** The library never populates this.uid; the real id is the JWT's `sub` claim. */
function decodeUid(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return p.sub || p.user_id || p.uid || p.id;
  } catch (e) { return undefined; }
}

async function connect(envDir) {
  loadEnv(envDir);
  const email = process.env.ANYLIST_EMAIL;
  const password = process.env.ANYLIST_PASSWORD;
  if (!email || !password) throw new Error('Missing ANYLIST_EMAIL / ANYLIST_PASSWORD in .env');
  const any = new AnyList({ email, password });
  await any.login(false); // no websocket for one-shot scripts
  return { any, uid: decodeUid(any.accessToken) };
}

async function disconnect(any) {
  if (any && typeof any.teardown === 'function') any.teardown();
}

/**
 * The success oracle. An ignored handler returns 200 with identical timestamps;
 * a real one bumps them and reports processedOperations.
 */
function readEditResponse(any, body) {
  try {
    const r = any.protobuf.PBEditOperationResponse.decode(body);
    const before = JSON.stringify(r.originalTimestamps || []);
    const after = JSON.stringify(r.newTimestamps || []);
    return { changed: before !== after, processed: (r.processedOperations || []).length };
  } catch (e) {
    return { changed: null, processed: null };
  }
}

async function postRaw(any, endpoint, buffer) {
  const form = new FormData();
  form.append('operations', buffer);
  const res = await any.client.post(endpoint, { body: form, throwHttpErrors: false });
  return { status: res.statusCode, ...readEditResponse(any, res.body) };
}

function mkOp(any, uid, handlerId) {
  const op = new any.protobuf.PBListOperation();
  op.setMetadata({ operationId: uuid(), handlerId, userId: uid });
  return op;
}

/** POST list operations. Returns { status, changed, processed }. Batch generously. */
async function postOps(any, ops) {
  const list = new any.protobuf.PBListOperationList();
  list.setOperations(Array.isArray(ops) ? ops : [ops]);
  return postRaw(any, LIST_ENDPOINT, list.toBuffer());
}

async function findList(any, name) {
  const lists = await any.getLists();
  return lists.find(l => l.name === name); // exact match on purpose — see SKILL.md
}

async function createList(any, uid, name) {
  const listId = uuid();
  const op = mkOp(any, uid, 'new-shopping-list');
  op.setListId(listId);
  const sl = new any.protobuf.ShoppingList();
  sl.setIdentifier(listId);
  sl.setName(name);
  sl.setTimestamp(Date.now() / 1000);
  if (uid) sl.setCreator(uid);
  op.setList(sl);
  await postOps(any, op);

  const created = await findList(any, name);
  if (!created) throw new Error(`createList("${name}") silently failed — not present after refetch`);
  return created;
}

/** Get by name, creating only if absent. Safe to re-run. */
async function ensureList(any, uid, name) {
  return (await findList(any, name)) || createList(any, uid, name);
}

async function deleteList(any, uid, list) {
  const op = mkOp(any, uid, 'remove-shopping-list');
  op.setListId(list.identifier);
  const sl = new any.protobuf.ShoppingList();
  sl.setIdentifier(list.identifier);
  sl.setName(list.name);
  sl.setTimestamp(Date.now() / 1000);
  op.setList(sl);
  await postOps(any, op);

  const lists = await any.getLists();
  if (lists.some(l => l.identifier === list.identifier)) {
    throw new Error(`deleteList("${list.name}") silently failed — still present`);
  }
}

/**
 * Add items, skipping names already on the list (case-insensitive), so re-runs can't
 * duplicate. All adds go in one request. De-duplicates; does not reconcile or prune.
 */
async function addItems(any, uid, list, names) {
  const present = new Set((list.items || []).map(i => (i.name || '').trim().toLowerCase()));
  const toAdd = names.filter(n => !present.has(n.trim().toLowerCase()));
  const skipped = names.length - toAdd.length;
  if (toAdd.length === 0) return { added: 0, skipped };

  const ops = toAdd.map(name => {
    const id = uuid();
    const op = mkOp(any, uid, 'add-shopping-list-item');
    op.setListId(list.identifier);
    op.setListItemId(id);
    op.setListItem(new any.protobuf.ListItem({ identifier: id, listId: list.identifier, name }));
    return op;
  });
  await postOps(any, ops);

  const after = await findList(any, list.name);
  const expected = present.size + toAdd.length;
  if (!after || after.items.length < expected) {
    throw new Error(`addItems silently failed on "${list.name}" — expected >=${expected}, found ${after ? after.items.length : 0}`);
  }
  return { added: toAdd.length, skipped };
}

/** Read-only: the account's global categories + groupings. Never write here. */
async function getUserCategories(any) {
  const res = await any.client.post('data/user-categories/all', { throwHttpErrors: false });
  return any.protobuf.PBUserCategoryData.decode(res.body);
}

async function getListState(any, listId) {
  const d = await any._getUserData(true);
  const list = d.shoppingListsResponse.newLists.find(l => l.identifier === listId);
  const r = (d.shoppingListsResponse.listResponses || []).find(x => x.listId === listId);
  const group = r && r.categoryGroupResponses[0] && r.categoryGroupResponses[0].categoryGroup;
  const allSettings = (d.listSettingsResponse && d.listSettingsResponse.newSettings) || [];
  return { list, group, settings: allSettings.find(s => s.listId === listId) };
}

/**
 * Point a list at one of the account's existing category groupings (by name, e.g. "Grocery").
 * The server then clones that grouping's categories into the list's own category group,
 * which is what makes aisle headers possible. Existing settings fields are preserved —
 * writing PBListSettings with unset scalars resets unrelated settings.
 */
async function attachCategoryGrouping(any, uid, listId, groupingName = 'Grocery') {
  const ucd = await getUserCategories(any);
  const grouping = ucd.groupings.find(g => g.name === groupingName);
  if (!grouping) {
    throw new Error(`No category grouping named "${groupingName}" (have: ${ucd.groupings.map(g => g.name).join(', ')})`);
  }
  const cur = (await getListState(any, listId)).settings || {};

  const apply = async (handlerId, mutate) => {
    const st = new any.protobuf.PBListSettings({
      identifier: cur.identifier || uuid(),
      userId: uid,
      listId,
      timestamp: Date.now() / 1000,
      listCategoryGroupId: cur.listCategoryGroupId || undefined,
      categoryGroupingId: cur.categoryGroupingId || undefined,
    });
    mutate(st);
    const op = new any.protobuf.PBListSettingsOperation();
    op.setMetadata({ operationId: uuid(), handlerId, userId: uid });
    op.setUpdatedSettings(st);
    const l = new any.protobuf.PBListSettingsOperationList();
    l.setOperations([op]);
    return postRaw(any, SETTINGS_ENDPOINT, l.toBuffer());
  };

  await apply('set-category-grouping-id', s => s.setCategoryGroupingId(grouping.identifier));
  await apply('set-should-hide-categories', s => s.setShouldHideCategories(false));

  const { group } = await getListState(any, listId);
  const count = (group && group.categories || []).length;
  if (count <= 1) throw new Error(`attachCategoryGrouping silently failed — list still has ${count} category`);
  return { grouping: grouping.name, categories: count };
}

/**
 * Assign items to system categories. `mapping` is { itemName: systemCategoryId },
 * e.g. { 'bananas': 'produce' }. Writes both ListItem.category and categoryMatchId.
 * Call attachCategoryGrouping() first or the categories won't exist on the list.
 */
async function setItemCategories(any, uid, listId, mapping) {
  const { list } = await getListState(any, listId);
  const byName = new Map((list.items || []).map(i => [(i.name || '').trim().toLowerCase(), i]));

  const ops = [];
  const missing = [];
  for (const [name, sys] of Object.entries(mapping)) {
    const item = byName.get(name.trim().toLowerCase());
    if (!item) { missing.push(name); continue; }
    const op = mkOp(any, uid, 'set-list-item-category');
    op.setListId(listId);
    op.setListItemId(item.identifier);
    op.setUpdatedValue(sys);
    ops.push(op);
  }
  if (ops.length === 0) return { assigned: 0, missing };

  const res = await postOps(any, ops);
  if (res.changed === false) throw new Error('setItemCategories silently failed — server ignored the operations');

  const after = await getListState(any, listId);
  const assigned = (after.list.items || []).filter(i => i.category).length;
  return { assigned, missing, ...res };
}

module.exports = {
  connect, disconnect, mkOp, postOps, postRaw, readEditResponse,
  findList, createList, ensureList, deleteList, addItems,
  getUserCategories, getListState, attachCategoryGrouping, setItemCategories,
  uuid, LIST_ENDPOINT, SETTINGS_ENDPOINT,
};
