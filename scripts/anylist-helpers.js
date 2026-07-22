// Reusable helpers for the AnyList API.
//
// Everything here verifies its own writes by re-fetching state, because AnyList returns
// HTTP 200 for operations it doesn't recognize and silently discards them. A status code
// is not evidence that anything changed.
//
// Usage:
//   const al = require('./anylist-helpers');
//   const { any, uid } = await al.connect(__dirname);
//   const list = await al.ensureList(any, uid, "Camp Grocery");
//   await al.addItems(any, uid, list, ['3 lb yellow onions', '2 lb carrots']);
//   await al.disconnect(any);

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const AnyList = require('anylist');
const uuid = require('anylist/lib/uuid');

const LIST_ENDPOINT = 'data/shopping-lists/update';

/** Load .env into process.env without ever printing values. */
function loadEnv(dir) {
  const p = path.join(dir, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

/**
 * The library never populates `this.uid`, so raw operations would send userId: undefined.
 * The real id is the `sub` claim of the JWT access token.
 */
function decodeUid(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return payload.sub || payload.user_id || payload.uid || payload.id;
  } catch (e) {
    return undefined;
  }
}

/** Log in. Pass the directory holding .env (usually __dirname). */
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

/** Build a PBListOperation with the given handlerId. */
function mkOp(any, uid, handlerId) {
  const op = new any.protobuf.PBListOperation();
  op.setMetadata({ operationId: uuid(), handlerId, userId: uid });
  return op;
}

/** POST one or more operations. Batch generously — one request handles many ops. */
async function postOps(any, ops) {
  const list = new any.protobuf.PBListOperationList();
  list.setOperations(Array.isArray(ops) ? ops : [ops]);
  const form = new FormData();
  form.append('operations', list.toBuffer());
  const res = await any.client.post(LIST_ENDPOINT, { body: form, throwHttpErrors: false });
  return res.statusCode;
}

async function findList(any, name) {
  const lists = await any.getLists();
  return lists.find(l => l.name === name);
}

/** Create a list. Throws if the server silently ignored the operation. */
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

  const created = await findList(any, name); // verify: 200 proves nothing
  if (!created) throw new Error(`createList("${name}") silently failed — list not present after refetch`);
  return created;
}

/** Get the list by name, creating it only if absent. Safe to re-run. */
async function ensureList(any, uid, name) {
  return (await findList(any, name)) || createList(any, uid, name);
}

/** Delete a list. Throws if it's still there afterwards. */
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
    throw new Error(`deleteList("${list.name}") silently failed — list still present`);
  }
}

/**
 * Add items, skipping any whose name already exists on the list (case-insensitive),
 * so re-running an import can't create duplicates. All adds go in one request.
 * Returns { added, skipped } and throws if the final count doesn't match.
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

  const after = await findList(any, list.name); // verify
  const expected = present.size + toAdd.length;
  if (!after || after.items.length < expected) {
    throw new Error(
      `addItems silently failed on "${list.name}" — expected >=${expected} items, found ${after ? after.items.length : 0}`
    );
  }
  return { added: toAdd.length, skipped };
}

/** Read-only: the account's global categories + groupings (writes here do not work). */
async function getUserCategories(any) {
  const res = await any.client.post('data/user-categories/all', { throwHttpErrors: false });
  return any.protobuf.PBUserCategoryData.decode(res.body);
}

module.exports = {
  connect, disconnect, mkOp, postOps, findList,
  createList, ensureList, deleteList, addItems, getUserCategories,
  uuid, LIST_ENDPOINT,
};
