import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchApi } from "./restep-mcp.mjs";

const root = new URL("https://api.example/api/");
test("credentials stay on the API origin, including each redirect hop", async () => {
  const seen = [];
  const fetch = async (url, options) => {
    seen.push([url.href, options.headers.get("authorization"), options.headers.get("cookie")]);
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    return seen.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://external.example/discovery" } })
      : new Response("{}");
  };
  await fetchApi(root, root, { headers: { cookie: "secret", authorization: "old" } }, { token: "test", fetch });
  assert.deepEqual(seen, [[root.href, "Bearer test", null], ["https://external.example/discovery", null, null]]);
  await fetchApi(root, "https://external.example/next", {}, { token: "test", fetch });
  assert.equal(seen[2][1], null);
});

test("same-origin redirects keep credentials and redirect loops stop", async () => {
  let count = 0;
  await assert.rejects(fetchApi(root, root, {}, { token: "test", fetch: async (_, options) => {
    count++;
    assert.equal(options.headers.get("authorization"), "Bearer test");
    return new Response(null, { status: 307, headers: { location: "/again" } });
  } }), /redirect/);
  assert.equal(count, 11);
});

test("writes cannot leave the origin or follow redirects", async () => {
  let count = 0;
  const fetch = async () => { count++; return new Response(null, { status: 307, headers: { location: "/again" } }); };
  await assert.rejects(fetchApi(root, "https://other.example/", { method: "POST" }, { fetch }), /another origin/);
  assert.equal(count, 0);
  await assert.rejects(fetchApi(root, root, { method: "POST", body: "secret" }, { fetch }), /redirect/);
  assert.equal(count, 1);
  await assert.rejects(fetchApi(root, "file:///tmp/example", {}, { fetch }), /HTTP/);
  await assert.rejects(fetchApi(root, "https://user:password@api.example/", {}, { fetch }), /credentials/);
});

// ── End to end: the adapter over stdio against the reference server and a mock server with what the
// reference lacks. Both listen on free ports the system picks. RESTEP_REF names another copy of the
// reference to test against (such as the committed one, while the working copy is being edited).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restepVersionProblem } from "./restep-mcp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(here, "restep-mcp.mjs");
const SERVER = process.env.RESTEP_REF || join(here, 'vendor/restep-server.mjs');
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// elicit: how the test client answers an elicitation/create request (11.1), when it offers elicitation.
function mcp(rootUrl, env = {}, { elicit = null } = {}) {
  const p = spawn(process.execPath, [ADAPTER, rootUrl], { env: { ...process.env, RESTEP_TOKEN: "", RESTEP_TRUST_EFFECTS: "", ...env }, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map();
  const asked = [];
  let next = 1;
  createInterface({ input: p.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    if (m.method === "elicitation/create") {
      asked.push(m.params);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: elicit(m.params) }) + "\n");
      return;
    }
    waiting.get(m.id)?.(m); waiting.delete(m.id);
  });
  const rpc = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const tool = async (name, args) => { const r = (await rpc("tools/call", { name, arguments: args })).result; return { isError: r.isError, text: r.content[0].text, json: () => JSON.parse(r.content[0].text) }; };
  // A call whose arguments go as written, so that numbers keep their source text (6.1).
  const rawTool = (name, argsText) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, (m) => resolve({ isError: m.result.isError, text: m.result.content[0].text }));
    p.stdin.write(`{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":${JSON.stringify(name)},"arguments":${argsText}}}\n`);
  });
  const init = (capabilities = {}) => rpc("initialize", { protocolVersion: "2025-11-25", capabilities });
  return { rpc, tool, rawTool, init, asked, close: () => p.kill() };
}

const d7 = {
  restep: "1.0-draft.7", profiles: ["core", "query", "writes"], extensions: ["actions", "inherit"], idempotency: { ttl: 86400, anonymous: false },
  collections: {
    things: {
      path: "/things", id_from: "derived",
      filter: { size: { type: "shape", ops: ["eq"] }, name: { type: "string", ops: ["eq"] } },
      named_filters: { odd: { type: "polygon", description: "Unknown type." } },
      actions: { zap: { on: "universe", safe: false, idempotent: false }, peek: { on: "item", safe: true, idempotent: true, method: "QUERY" } },
      inherit: { rate: { own: "rate_own", from: [], default: true } },
    },
  },
  singletons: {
    prefs: { path: "/prefs", methods: ["GET", "PATCH"] }, tpl: { path: "/u/{id}/prefs" },
    kid: { path: "/things/{thing_id}/kid", parent: "things" }, orphan: { path: "/x/{id}/y", parent: "nothing" },
  },
};
// Draft 7 features the reference does not have yet (4.2, 4.3, 5.1, 5.4, 5.7, 5.9, 6.1, 11.1, 11.6).
const n7 = {
  restep: "1.0-draft.7", profiles: ["core", "query", "writes"], extensions: ["actions", "inherit"], idempotency: { ttl: 1 },
  collections: {
    orders: {
      path: "/orders", methods: ["GET", "POST"], item_methods: ["GET", "PATCH", "DELETE"],
      method_effects: { POST: ["charges"] }, item_method_effects: { PATCH: [], DELETE: [] },
      filter: {
        "lines.sku": { type: "string", ops: ["eq", "nin"], quantifier: "some" },
        tags: { type: "string", ops: ["eq"], quantifier: "every" },
        title: { type: "string", ops: ["prefix", "contains", "regex"] },
        lines: { type: "string", ops: ["null"] }, pages: { type: "integer", ops: ["eq", "in"] },
        labels: { type: "string", ops: ["null"], quantifier: "some" }, // council round 3, decision 8
      },
      relations: { lines: { to: "lines", many: true } },
      named_filters: { active: { default: true, description: "Not archived." }, mine: { description: "Mine." } },
      language_maps: { name_i18n: {} }, localized: { name: { source: "name_i18n" } },
      actions: {
        compare: { on: "item", safe: true, idempotent: true, method: "GET", params: { with: { type: "string", required: true }, ids: { type: "string", list: true } }, output: { type: "object" } },
        quote: { on: "item", safe: true, idempotent: true, method: "GET", effects: ["charges"] },
        peek: { on: "item", safe: true, idempotent: true, method: "GET", effects: ["teleports"] },
        pay: { on: "item", safe: false, idempotent: false, effects: ["charges", "external"] },
        archive: { on: "item", safe: false, idempotent: true, effects: [] },
        new: { on: "collection", safe: true, idempotent: true, method: "GET", output: { type: "object" } },
        ping: { on: "item", safe: true, idempotent: true, method: "GET" },
      },
    },
    things: { path: "/things", item_methods: ["GET", "PATCH", "DELETE"], item_method_effects: { PATCH: ["destroys", "teleports"] } },
    payments: { path: "/payments", methods: ["POST"] },
    files: { path: "/files", methods: ["POST"], upload: { media_types: ["image/*", "application/pdf"] } },
    docs: { path: "/docs", methods: ["POST"], upload: { media_types: ["image/*", "application/pdf"] }, schemas: { create: { type: "object" } } },
    readers: { path: "/readers" },
    stores: { path: "/stores", inherit: { rate: { own: "rate_own", from: [], "x-acme-note": "the server's own member" }, fee: { own: "fee_own", from: [] }, tax: { own: "tax_own", from: [], mode: "unknown member" } } },
    prefs: { path: "/stores/{store_id}/prefs", parent: "stores", inherit_items: { from: ["chain"], key: ["publisher"], "x-acme-note": 1 } },
    shelves: { path: "/stores/{store_id}/shelves", parent: "stores", inherit_items: { from: ["chain"], mode: "unknown member" } },
  },
  singletons: {
    settings: { path: "/readers/{reader_id}/settings", parent: "readers", methods: ["GET", "PATCH"] },
    me: { path: "/me", actions: { verify: { safe: false, idempotent: true, effects: [] } } },
    profile: { path: "/profile", methods: ["GET", "PATCH"], method_effects: { PATCH: ["external"] } },
    quiet: { path: "/quiet", methods: ["GET", "PATCH"], method_effects: { PATCH: [] } },
    orphan: { path: "/x/{id}/y", parent: "nothing" },
  },
};
const problem = (status, code, extra = {}) => ({ type: `https://w3id.org/restep/1/errors#${code}`, title: code, status, code, ...extra });
const mockRoots = {
  "/d6/": { ...d7, restep: "1.0-draft.6" }, "/d7/": d7, "/n7/": n7, "/v2/": { restep: "2.0", collections: { books: { path: "/books" } } },
  "/rsd/v2": { restep: "2.0", collections: {} },
  "/s7/": { restep: "1.0-draft.7", profiles: ["core", "writes"], collections: { things: { path: "/things", item_method_effects: { PATCH: [], DELETE: [] } } },
    singletons: { profile: { path: "/profile", methods: ["GET", "PATCH"], method_effects: { PATCH: ["external"] } }, quiet: { path: "/quiet", method_effects: { PATCH: [] } } } }, "/rsd/d": { ...n7, collections: { found: { path: "/found" } } },
};
let seen = [];

test("draft 7 end to end: version, singletons, unknown values, id_from, anonymous, inherit and effects", { timeout: 60000 }, async (t) => {
  const REF_PORT = await freePort();
  const ref = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(REF_PORT), RESTEP_TOKEN: "" }, stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((r) => ref.stdout.once("data", r));
  const mock = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, key: req.headers["idempotency-key"] ?? null, body, lang: req.headers["accept-language"] ?? null });
    const send = (s, d, h = {}) => { res.writeHead(s, { "content-type": s >= 400 ? "application/problem+json" : "application/json", ...h }); res.end(JSON.stringify(d)); };
    const url = req.url;
    if (mockRoots[url]) return send(200, mockRoots[url]);
    if (url === "/r401/") return send(401, problem(401, "unauthenticated"), { "www-authenticate": 'Bearer realm="api"' });
    if (url === "/r503/") return send(503, problem(503, "unavailable"));
    if (url === "/r404/") return send(404, problem(404, "not_found"));
    if (url === "/rsd/") return send(200, { hello: "not discovery" }, { link: '</rsd/v2>; rel="service-desc", </rsd/d>; rel="service-desc"' });
    if (url === "/n7/orders/e418") return send(418, problem(418, "http_418"));
    if (url === "/n7/orders/e408") return send(408, problem(408, "request_timeout"));
    if (url === "/n7/orders/e451") return send(451, problem(451, "censored"));
    if (url.startsWith("/n7/orders/1:compare")) return send(200, { fields: [{ name: "pages", from: 1, to: 2 }] });
    if ((url === "/n7/files" || url === "/n7/docs") && req.method === "POST") return send(415, problem(415, "unsupported_media_type"), { "accept-post": "image/*, application/pdf" });
    if (url === "/n7/orders:new") return send(200, { values: { qty: 1 }, schema: { type: "object" } });
    if (url === "/n7/stores/1" && req.method === "PATCH") return send(422, problem(422, "invalid", { errors: [{ pointer: "/rate", code: "read_only" }, { pointer: "/fee", code: "read_only" }, { pointer: "/tax", code: "read_only" }] }));
    if (url === "/n7/stores/1/prefs/p1" || url === "/n7/stores/1/shelves/s1") return send(409, problem(409, "conflict"));
    if (url.startsWith("/d6/things") || url.startsWith("/d7/things") || url.startsWith("/n7/")) return send(req.method === "POST" ? 201 : 200, { items: [], next: null, id: "n" });
    if (url === "/d7/prefs") return send(200, { theme: "dark" });
    send(404, problem(404, "not_found"));
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const MOCK = `http://127.0.0.1:${mock.address().port}`;
  const clients = [];
  const open = (u, env, opts) => { const c = mcp(u, env, opts); clients.push(c); return c; };
  try {
    await t.test("accepts the reference's Restep 1 version and uses its shop singleton (§1.1, §5.9)", async () => {
      const c = open(`http://localhost:${REF_PORT}/`);
      const names = (await c.rpc("tools/list")).result.tools.map((x) => x.name);
      assert.ok(names.includes("get_singleton") && names.includes("update_singleton"), names.join());
      const d = await c.tool("describe", {});
      assert.equal(restepVersionProblem(d.json().restep), null, d.text.slice(0, 200));
      const g = await c.tool("get_singleton", { singleton: "shop" });
      assert.equal(g.isError, false); assert.equal(typeof g.json().body.name, "string");
      const f = await c.tool("get_singleton", { singleton: "shop", fields: ["name"] });
      assert.equal(f.json().body.max_reservations, undefined);
      // §4.3, §11.1: a singleton's PATCH declares no effects, so it needs the user's approval first.
      const no = await c.tool("update_singleton", { singleton: "shop", patch: { name: g.json().body.name } });
      assert.ok(no.isError && /approval/.test(no.text), no.text);
      const u = await c.tool("update_singleton", { singleton: "shop", patch: { name: g.json().body.name }, approved: true });
      assert.equal(u.json().status, 200);
    });
    await t.test("subcollection with parent_ids, include, href, type and actions against the reference (§4.2, §9, §11.1)", async () => {
      const c = open(`http://localhost:${REF_PORT}/`);
      const tools = (await c.rpc("tools/list")).result.tools;
      assert.ok(tools.find((x) => x.name === "list").inputSchema.properties.include, "list offers include with relations");
      // reviews hangs off books: without parent_ids it cannot be done; a book that does not exist gives 404.
      const no = await c.tool("list", { collection: "reviews" });
      assert.ok(no.isError && /parent_ids/.test(no.text), no.text);
      const r = await c.tool("list", { collection: "reviews", parent_ids: ["7"] });
      assert.equal(r.json().status, 200); assert.ok(r.json().body.items.length >= 1);
      assert.equal((await c.tool("list", { collection: "reviews", parent_ids: ["no-existe"] })).json().status, 404);
      // include with depth 2; deeper, or through a non-includable relation, fails before sending.
      const p = await c.tool("list", { collection: "products", include: ["category.parent"] });
      assert.ok(p.json().body.items.some((x) => x.category?.parent?.name), p.text.slice(0, 300));
      const deep = await c.tool("list", { collection: "products", include: ["category.parent.parent"] });
      assert.ok(deep.isError && /include_depth/.test(deep.text), deep.text);
      const bad = await c.tool("get", { collection: "books", id: "7", include: ["editor"] });
      assert.ok(bad.isError && /Includable: author, related, highlight/.test(bad.text), bad.text);
      // highlight leads to an item of reviews by its href; showcase, to books or products by its type.
      const b = await c.tool("get", { collection: "books", id: "7", include: ["highlight"] });
      const hl = b.json().body.highlight;
      assert.equal(hl.href, `/books/7/reviews/${hl.id}`);
      const [, , parent, , rid] = hl.href.split("/");
      assert.equal((await c.tool("get", { collection: "reviews", id: rid, parent_ids: [parent] })).json().body.text, hl.text);
      const cats = await c.tool("list", { collection: "categories", include: ["showcase"] });
      const shown = cats.json().body.items.map((x) => x.showcase).filter(Boolean);
      assert.ok(shown.length && shown.every((x) => ["books", "products"].includes(x.type)));
      for (const s of shown) assert.equal((await c.tool("get", { collection: s.type, id: s.id })).json().status, 200);
      // Actions: collection GET, item POST with input, idempotent.
      const low = await c.tool("action", { collection: "products", name: "low_stock" });
      // §11.1: a safe action that declares output answers with its result, given as output.
      assert.ok(!low.isError, low.text); assert.ok((low.json().output ?? low.json().body).items.every((x) => x.stock < 5), low.text.slice(0, 300));
      const before = (await c.tool("get", { collection: "products", id: "1" })).json().body.stock;
      const rs = await c.tool("action", { collection: "products", name: "restock", id: "1", body: { quantity: 2 }, idempotency_key: crypto.randomUUID(), approved: true });
      assert.equal(rs.json().body.stock, before + 2);
      const inv = await c.tool("action", { collection: "products", name: "restock", id: "1", body: { quantity: 0 }, approved: true });
      assert.equal(inv.json().status, 422);
      const f1 = await c.tool("action", { collection: "authors", name: "find_or_create", body: { name: "Autora de restep-mcp" }, approved: true });
      const f2 = await c.tool("action", { collection: "authors", name: "find_or_create", body: { name: "Autora de restep-mcp" }, approved: true });
      // §11.1: an unsafe action on a collection answers 201 with Location or 204, never 200.
      assert.equal(f1.json().status, 201); assert.ok([201, 204].includes(f2.json().status), f2.text);
      if (f2.json().status === 201) assert.equal(f2.json().headers.location, f1.json().headers.location);
      const it = await c.tool("action", { collection: "categories", name: "inherit_tax", id: "2", approved: true });
      assert.equal(it.json().status, 200);
      const wrong = await c.tool("action", { collection: "authors", name: "find_or_create", id: "1", body: { name: "x" } });
      assert.ok(wrong.isError && /collection/.test(wrong.text), wrong.text);
    });
    await t.test("another major version is not Restep 1 and does not fall back to core (§1.1)", async () => {
      assert.equal(restepVersionProblem("1.0-rc.1"), null);
      assert.match(restepVersionProblem("1.01"), /grammar/);
      const c = open(`${MOCK}/v2/`);
      const d = await c.tool("describe", {});
      assert.ok(d.isError && /not Restep 1/.test(d.text), d.text);
      const l = await c.tool("list", { collection: "books" });
      assert.ok(l.isError && /not Restep 1/.test(l.text), l.text);
      assert.ok(!seen.some((s) => s.url === "/v2/books"));
    });
    await t.test("unknown values and reserved singletons are not used (§4.2, §5.9)", async () => {
      const c = open(`${MOCK}/d7/`);
      const tools = (await c.rpc("tools/list")).result.tools;
      // §5.9: a template without parent, or a parent that names nothing, is ignored; one under an item is used.
      assert.deepEqual(tools.find((x) => x.name === "get_singleton").inputSchema.properties.singleton.enum, ["prefs", "kid"]);
      seen = [];
      const kid = await c.tool("get_singleton", { singleton: "kid", parent_ids: ["7"] });
      assert.equal(kid.json().status, 200, kid.text);
      assert.equal(seen[0].url, "/d7/things/7/kid");
      const noParent = await c.tool("get_singleton", { singleton: "kid" });
      assert.ok(noParent.isError && /parent_ids/.test(noParent.text), noParent.text);
      for (const [args, re] of [[{ filter: { size: { eq: "3" } } }, /does not know/], [{ filter: { name: { regex: "a" } } }, /unknown operator/], [{ named_filters: { odd: "x" } }, /does not know/]]) {
        const r = await c.tool("list", { collection: "things", ...args });
        assert.ok(r.isError && re.test(r.text), r.text);
      }
      const z = await c.tool("action", { collection: "things", name: "zap" });
      assert.ok(z.isError && /does not know/.test(z.text), z.text);
      const p = await c.tool("action", { collection: "things", name: "peek", id: "1" });
      assert.ok(p.isError, p.text);
      assert.ok(!seen.some((s) => /zap|peek|size|odd|regex/.test(s.url)));
    });
    await t.test("unknown id_from: sends no id (§5.1); anonymous false: no key (§7.1)", async () => {
      const c = open(`${MOCK}/d7/`);
      const tools = (await c.rpc("tools/list")).result.tools;
      assert.equal(tools.find((x) => x.name === "create").inputSchema.properties.idempotency_key, undefined);
      const a = await c.tool("create", { collection: "things", body: { id: "a", x: 1 } });
      assert.ok(a.isError && /id_from/.test(a.text), a.text);
      const k = await c.tool("create", { collection: "things", body: { x: 1 }, idempotency_key: "k", approved: true });
      assert.ok(k.isError && /anonymous/.test(k.text), k.text);
      seen = [];
      const b = await c.tool("create", { collection: "things", body: { x: 1 }, approved: true });
      assert.equal(b.json().status, 201);
      assert.equal(seen[0].key, null);
      const withToken = open(`${MOCK}/d7/`, { RESTEP_TOKEN: "t" });
      const t2 = (await withToken.rpc("tools/list")).result.tools;
      assert.ok(t2.find((x) => x.name === "create").inputSchema.properties.idempotency_key);
    });
    await t.test("experimental inherit only with the draft it knows (§1.2)", async () => {
      const a = open(`${MOCK}/d7/`);
      const ia = (await a.rpc("initialize", {})).result.instructions;
      assert.match(ia, /inherited values/); assert.match(ia, /other "from" as "hidden"/);
      const b = open(`${MOCK}/d6/`);
      const ib = (await b.rpc("initialize", {})).result.instructions;
      assert.doesNotMatch(ib, /inherited values/);
    });
    await t.test("core only after a 2xx without restep or a 404, never after another error (§4.2, B-06)", async () => {
      for (const [root, re] of [["r401", /answered 401.*RESTEP_TOKEN/], ["r503", /answered 503/]]) {
        const c = open(`${MOCK}/${root}/`);
        const d = await c.tool("describe", {});
        assert.ok(d.isError && re.test(d.text), d.text);
        const l = await c.tool("list", { collection: "books" });
        assert.ok(l.isError && /could not be read/.test(l.text), l.text);
      }
      const c = open(`${MOCK}/r404/`);
      const d = await c.tool("describe", {});
      assert.deepEqual(d.json().profiles, ["core"]);
    });
    await t.test("of several service-desc links, the first discovery document of Restep 1 (§4.2, C-21)", async () => {
      const c = open(`${MOCK}/rsd/`);
      const d = await c.tool("describe", {});
      assert.deepEqual(Object.keys(d.json().collections), ["found"], d.text.slice(0, 200));
    });
    await t.test("effects: approval before a declared effect, and before [] unless trusted; hints from effects (§4.3, §11.1, §13.1, C-32, C-115)", async () => {
      const c = open(`${MOCK}/n7/`);
      const tools = Object.fromEntries((await c.rpc("tools/list")).result.tools.map((x) => [x.name, x]));
      // A collection with undeclared effects (things: unknown value) makes update destructive; DELETE [] and undeclared DELETE.
      assert.equal(tools.update.annotations.destructiveHint, true);
      assert.equal(tools.update.annotations.openWorldHint, true);
      assert.equal(tools.create.annotations.destructiveHint, true, "collections without method_effects count as having all three");
      assert.ok(tools.create.inputSchema.properties.approved);
      seen = [];
      const pay = await c.tool("action", { collection: "orders", name: "pay", id: "1" });
      assert.ok(pay.isError && /charges \(costs money\).*external/.test(pay.text), pay.text);
      const arch = await c.tool("action", { collection: "orders", name: "archive", id: "1" });
      assert.ok(arch.isError && /does not trust/.test(arch.text), arch.text);
      const create = await c.tool("create", { collection: "orders", body: { qty: 1 } });
      assert.ok(create.isError && /charges/.test(create.text), create.text);
      const del = await c.tool("delete", { collection: "orders", id: "1" });
      assert.ok(del.isError && /approval/.test(del.text), "DELETE [] still asks without trust");
      const delThings = await c.tool("delete", { collection: "things", id: "1" });
      assert.ok(delThings.isError && /destroys/.test(delThings.text) && !/charges/.test(delThings.text), delThings.text);
      const patchThings = await c.tool("update", { collection: "things", id: "1", patch: { a: 1 } });
      assert.ok(patchThings.isError && /destroys.*external.*charges/.test(patchThings.text), "an unknown effect counts as all three");
      const quote = await c.tool("action", { collection: "orders", name: "quote", id: "1" });
      assert.ok(quote.isError && /charges/.test(quote.text), "a safe action that declares charges asks too");
      const peek = await c.tool("action", { collection: "orders", name: "peek", id: "1" });
      assert.ok(peek.isError && /destroys.*external.*charges/.test(peek.text), "a safe action with an unknown effect counts as all three");
      assert.deepEqual(seen, [], "nothing was sent before approval");
      const ok = await c.tool("action", { collection: "orders", name: "pay", id: "1", approved: true });
      assert.equal(ok.json().status, 201);
      const safe = await c.tool("action", { collection: "orders", name: "new" });
      assert.equal(safe.isError, false, "a safe action without effects runs without asking");
      // Trusted: [] runs without asking; a declared effect still asks.
      const tr = open(`${MOCK}/n7/`, { RESTEP_TRUST_EFFECTS: "1" });
      await tr.rpc("tools/list");
      seen = [];
      assert.equal((await tr.tool("action", { collection: "orders", name: "archive", id: "1" })).json().status, 201);
      assert.equal((await tr.tool("update", { collection: "orders", id: "1", patch: { qty: 2 } })).json().status, 200);
      assert.ok((await tr.tool("action", { collection: "orders", name: "pay", id: "1" })).isError);
      assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ["POST /n7/orders/1:archive", "PATCH /n7/orders/1"]);
    });
    await t.test("effects: asks the person through elicitation when the client offers it (§11.1)", async () => {
      let answer = { action: "decline" };
      const c = open(`${MOCK}/n7/`, {}, { elicit: () => answer });
      await c.init({ elicitation: {} });
      const tools = Object.fromEntries((await c.rpc("tools/list")).result.tools.map((x) => [x.name, x]));
      assert.equal(tools.action.inputSchema.properties.approved, undefined, "no approved argument with elicitation");
      seen = [];
      const no = await c.tool("action", { collection: "orders", name: "pay", id: "1" });
      assert.ok(no.isError && /did not approve/.test(no.text), no.text);
      assert.match(c.asked[0].message, /POST \/orders\/1:pay.*charges/);
      assert.deepEqual(seen, []);
      answer = { action: "accept", content: { approve: true } };
      const yes = await c.tool("action", { collection: "orders", name: "pay", id: "1", approved: false });
      assert.equal(yes.json().status, 201);
      assert.equal(c.asked.length, 2);
    });
    await t.test("params are the input of a GET action, output its result (§11.1, C-113)", async () => {
      const c = open(`${MOCK}/n7/`);
      await c.rpc("tools/list");
      seen = [];
      const r = await c.tool("action", { collection: "orders", name: "compare", id: "1", params: { with: "a,b", ids: ["x", "y"] } });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(r.json().output, { fields: [{ name: "pages", from: 1, to: 2 }] });
      assert.equal(r.json().body, undefined);
      assert.equal(seen[0].url, "/n7/orders/1:compare?with=a,b&ids=x,y");
      for (const [params, re] of [[{}, /requires params: with/], [{ with: "a", other: 1 }, /no parameter "other"/], [{ with: "a", ids: ["x,y"] }, /cannot contain commas/], [{ with: ["a"] }, /one value/]]) {
        const e = await c.tool("action", { collection: "orders", name: "compare", id: "1", params });
        assert.ok(e.isError && re.test(e.text), e.text);
      }
      const body = await c.tool("action", { collection: "orders", name: "compare", id: "1", body: {} });
      assert.ok(body.isError && /params, not a body/.test(body.text), body.text);
    });
    await t.test("singletons under an item, and singleton actions (§5.9, §11.1, C-76, C-77)", async () => {
      const c = open(`${MOCK}/n7/`);
      const tools = Object.fromEntries((await c.rpc("tools/list")).result.tools.map((x) => [x.name, x]));
      assert.deepEqual(tools.get_singleton.inputSchema.properties.singleton.enum, ["settings", "me", "profile", "quiet"]);
      seen = [];
      assert.equal((await c.tool("update_singleton", { singleton: "settings", parent_ids: ["9"], patch: { a: 1 }, approved: true })).json().status, 200);
      assert.equal((await c.tool("action", { singleton: "me", name: "verify", approved: true })).json().status, 201);
      assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ["PATCH /n7/readers/9/settings", "POST /n7/me:verify"]);
      const both = await c.tool("action", { singleton: "me", collection: "orders", name: "verify" });
      assert.ok(both.isError && /one of/.test(both.text), both.text);
    });
    await t.test("localized fields are left to the server; default and required filters; quantifier and new operators (§3, §6.1, C-19, C-80, C-83, C-86)", async () => {
      const c = open(`${MOCK}/n7/`);
      const tools = Object.fromEntries((await c.rpc("tools/list")).result.tools.map((x) => [x.name, x]));
      assert.match(tools.list.description, /localized fields/);
      assert.match(tools.list.inputSchema.properties.named_filters.description, /"default": true.*pass false/);
      assert.match(tools.list.inputSchema.properties.filter.description, /quantifier.*some related item/);
      assert.match(tools.create.description, /action "new"/);
      // §5.1: a write may carry a localized field (with the value the item would have): the server decides.
      seen = [];
      const loc = await c.tool("update", { collection: "orders", id: "1", patch: { name: "x" }, approved: true });
      assert.equal(loc.json().status, 200, loc.text);
      assert.deepEqual(JSON.parse(seen[0].body), { name: "x" });
      assert.match(tools.update.description, /Localized fields are read-only: write their source language map/);
      seen = [];
      const off = await c.tool("list", { collection: "orders", named_filters: { active: false }, filter: { "lines.sku": { nin: ["a", "b"] }, title: { prefix: "La", contains: "niebla" } } });
      assert.equal(off.json().status, 200, off.text);
      assert.equal(decodeURIComponent(seen[0].url), "/n7/orders?filter[lines.sku][nin]=a,b&filter[title][prefix]=La&filter[title][contains]=niebla&filter[active]=false");
      const mine = await c.tool("list", { collection: "orders", named_filters: { mine: false } });
      assert.ok(mine.isError && /Only a default switch \(active\)/.test(mine.text), mine.text);
      const q = await c.tool("list", { collection: "orders", filter: { tags: { eq: "a" } } });
      assert.ok(q.isError && /quantifier/.test(q.text), "an unknown quantifier makes the filter unusable");
      const noGet = await c.tool("list", { collection: "payments" });
      assert.ok(noGet.isError && /cannot be listed/.test(noGet.text), noGet.text);
    });
    await t.test("council round 1: null without quantifier, 20.0 as an integer, GET action without params, a singleton's method_effects, Accept-Post (§4.3, §5.1, §5.3, §5.9, §6.1, §11.1)", async () => {
      const c = open(`${MOCK}/n7/`);
      const tools = Object.fromEntries((await c.rpc("tools/list")).result.tools.map((x) => [x.name, x]));
      seen = [];
      // 1: null on a to-many relationship declared without quantifier; 3: 20.0 goes as is, the server decides.
      const n = await c.tool("list", { collection: "orders", filter: { lines: { null: true }, pages: { eq: "20.0", in: ["1", "2.0"] } } });
      assert.equal(n.json().status, 200, n.text);
      assert.equal(decodeURIComponent(seen[0].url), "/n7/orders?filter[lines][null]=true&filter[pages][eq]=20.0&filter[pages][in]=1,2.0");
      // 6: a GET action without params takes none.
      seen = [];
      const p = await c.tool("action", { collection: "orders", name: "ping", id: "1", params: { x: "1" } });
      assert.ok(p.isError && /declares no params, so it takes none/.test(p.text), p.text);
      assert.deepEqual(seen, []);
      assert.equal((await c.tool("action", { collection: "orders", name: "ping", id: "1" })).isError, false);
      assert.equal(seen[0].url, "/n7/orders/1:ping");
      assert.match(tools.action.inputSchema.properties.params.description, /declares no params: it takes none/);
      // 8: a singleton's PATCH uses its method_effects; undeclared, all three.
      seen = [];
      const prof = await c.tool("update_singleton", { singleton: "profile", patch: { a: 1 } });
      assert.ok(prof.isError && /external/.test(prof.text) && !/destroys/.test(prof.text), prof.text);
      const set = await c.tool("update_singleton", { singleton: "settings", parent_ids: ["9"], patch: { a: 1 } });
      assert.ok(set.isError && /destroys.*external.*charges/.test(set.text), set.text);
      assert.deepEqual(seen, []);
      assert.equal(tools.update_singleton.annotations.destructiveHint, true, "settings declares nothing: all three");
      const tr = open(`${MOCK}/n7/`, { RESTEP_TRUST_EFFECTS: "1" });
      await tr.rpc("tools/list");
      assert.equal((await tr.tool("update_singleton", { singleton: "quiet", patch: { a: 1 } })).isError, false, "PATCH [] trusted runs without asking");
      assert.ok((await tr.tool("update_singleton", { singleton: "profile", patch: { a: 1 } })).isError, "a declared effect still asks");
      // 2: a 415 hints with Accept-Post.
      const f = await c.tool("create", { collection: "docs", body: { name: "x" }, approved: true });
      assert.equal(f.json().status, 415);
      assert.match(f.json().hint, /It accepts: image\/\*, application\/pdf \(files, not a JSON body\)/);
    });
    await t.test("council round 3: upload without create, null on a group, numbers of RFC 8259, a replay without ETag (§5.1, §6.1, §7.3)", async () => {
      const c = open(`${MOCK}/n7/`, { RESTEP_TOKEN: "t" });
      const tools = Object.fromEntries((await c.rpc("tools/list")).result.tools.map((x) => [x.name, x]));
      // 1: a collection with upload and without schemas.create takes only files: create refuses it before sending.
      seen = [];
      const f = await c.tool("create", { collection: "files", body: { name: "x" }, approved: true });
      assert.ok(f.isError && /upload without create: it takes only files/.test(f.text), f.text);
      assert.deepEqual(seen, []);
      assert.match(tools.create.description, /without schemas\.create it takes only files/);
      // 8: null alone, declared with "quantifier": "some", is sent like any filter; 9: the descriptions say it tests the group.
      const n = await c.tool("list", { collection: "orders", filter: { labels: { null: true } } });
      assert.equal(n.json().status, 200, n.text);
      assert.equal(decodeURIComponent(seen[0].url), "/n7/orders?filter[labels][null]=true");
      const fd = tools.list.inputSchema.properties.filter.description;
      assert.match(fd, /tests the whole relationship or list, never each element/);
      assert.match(fd, /true means that no visible element matches all of them at once and false that some does/);
      assert.match(fd, /whether it is declared with "quantifier": "some" or without it/);
      // 7: the grammar of numbers, in the description (the server decides).
      assert.match(fd, /2e1 \(which is 20\), never \+20, \.5, 020 or 0x14/);
      // 5: a replay may carry no ETag: read the item.
      assert.match(tools.create.description, /may carry no headers\.etag: to get one for if_match, read the item with get/);
    });
    await t.test("council round 4: one null per group in the description, numeric operands as written (§6.1)", async () => {
      const c = open(`${MOCK}/n7/`, { RESTEP_TOKEN: "t" });
      const tools = Object.fromEntries((await c.rpc("tools/list")).result.tools.map((x) => [x.name, x]));
      // 5a: the server decides (this adapter does not check filter values), and the description says it.
      assert.match(tools.list.inputSchema.properties.filter.description, /Only one null filter goes on the same relationship or list, its own or that of a path through it: .* fails with invalid_parameter, even when the values agree/);
      // 6: a number a double cannot hold goes as written, never as Infinity, 0 or another integer.
      seen = [];
      const r = await c.rawTool("list", '{"collection":"orders","filter":{"pages":{"eq":1e400,"in":[-1e-400,12345678901234567891,2.50,20]}}}');
      assert.ok(!r.isError, r.text);
      assert.equal(decodeURIComponent(seen[0].url), "/n7/orders?filter[pages][eq]=1e400&filter[pages][in]=-1e-400,12345678901234567891,2.5,20");
    });
    await t.test("update_singleton is not destructive when every singleton declares a PATCH without destroys (§4.3, §5.9)", async () => {
      // Served from mockRoots below: only singletons with method_effects.
      const c = open(`${MOCK}/s7/`);
      const tools = Object.fromEntries((await c.rpc("tools/list")).result.tools.map((x) => [x.name, x]));
      assert.equal(tools.update_singleton.annotations.destructiveHint, false);
      assert.equal(tools.update_singleton.annotations.openWorldHint, true);
    });
    await t.test("codes of the closed table and unknown ones, by the class of the status (§5.4, §5.7, C-63)", async () => {
      const c = open(`${MOCK}/n7/`);
      const h = async (id) => (await c.tool("get", { collection: "orders", id })).json();
      assert.match((await h("e408")).hint, /repeated as is/);
      assert.match((await h("e418")).hint, /client error \(418\)/);
      assert.match((await h("e451")).hint, /not one this adapter knows/);
    });
    await t.test("an idempotency key is not repeated after idempotency.ttl (§5.7, C-71)", async () => {
      const c = open(`${MOCK}/n7/`, { RESTEP_TOKEN: "t" });
      const args = { collection: "orders", body: { qty: 1 }, idempotency_key: "k-ttl", approved: true };
      assert.equal((await c.tool("create", args)).json().status, 201);
      assert.equal((await c.tool("create", args)).json().status, 201, "within the ttl the key can be repeated");
      await new Promise((r) => setTimeout(r, 1100));
      seen = [];
      const late = await c.tool("create", args);
      assert.ok(late.isError && /more than 1 seconds/.test(late.text), late.text);
      assert.deepEqual(seen, []);
    });
    await t.test("inherit: unknown members make a field not inherited; inherited items (§11.6, C-25, C-131)", async () => {
      const c = open(`${MOCK}/n7/`);
      const init = (await c.rpc("initialize", {})).result.instructions;
      assert.match(init, /inherit_items/);
      const w = await c.tool("update", { collection: "stores", id: "1", patch: { rate: "1", fee: "2", tax: "3" }, approved: true });
      assert.match(w.json().hint, /fee is the effective value of an inherited field: write fee_own/);
      assert.match(w.json().hint, /write rate_own/, "an x- member is the server's own: rate is still inherited");
      assert.doesNotMatch(w.json().hint, /tax_own/, "tax's declaration carries a member the adapter does not know");
      const p = await c.tool("delete", { collection: "prefs", id: "p1", parent_ids: ["1"], approved: true });
      assert.match(p.json().hint, /_from.*inherited/, "inherit_items with an x- member is still used");
      const sh = await c.tool("delete", { collection: "shelves", id: "s1", parent_ids: ["1"], approved: true });
      assert.equal(sh.json().hint, undefined, "inherit_items with an unknown member is not used");
    });
  } finally {
    for (const c of clients) c.close();
    ref.kill();
    mock.close();
  }
});

test("only https links or links with the root's scheme are followed (§3)", async () => {
  const fetch = async () => new Response("{}");
  const secure = new URL("https://api.example/");
  await assert.rejects(fetchApi(secure, "http://api.example/next", {}, { fetch }), /HTTPS/);
  await fetchApi(new URL("http://localhost/"), "http://localhost/next", {}, { fetch });
});
