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

// ── Borrador 6, de punta a punta: el adaptador por stdio contra la referencia (puerto 8961) y un
// servidor simulado (puerto 8962) con lo que la referencia no tiene.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restepVersionProblem } from "./restep-mcp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(here, "restep-mcp.mjs");
const SERVER = join(here, 'vendor/restep-server.mjs');
const REF_PORT = 8961, MOCK_PORT = 8962;

function mcp(rootUrl, env = {}) {
  const p = spawn(process.execPath, [ADAPTER, rootUrl], { env: { ...process.env, RESTEP_TOKEN: "", ...env }, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map();
  let next = 1;
  createInterface({ input: p.stdout }).on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); });
  const rpc = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const tool = async (name, args) => { const r = (await rpc("tools/call", { name, arguments: args })).result; return { isError: r.isError, text: r.content[0].text, json: () => JSON.parse(r.content[0].text) }; };
  return { rpc, tool, close: () => p.kill() };
}

const d6 = {
  restep: "1.0-draft.6", profiles: ["core", "query", "writes"], extensions: ["actions", "inherit"], idempotency: { ttl: 86400, anonymous: false },
  collections: {
    things: {
      path: "/things", id_from: "derived",
      filter: { size: { type: "shape", ops: ["eq"] }, name: { type: "string", ops: ["eq"] } },
      named_filters: { odd: { type: "polygon", description: "Unknown type." } },
      actions: { zap: { on: "universe", safe: false, idempotent: false }, peek: { on: "item", safe: true, idempotent: true, method: "QUERY" } },
      inherit: { rate: { own: "rate_own", from: [], default: true } },
    },
  },
  singletons: { prefs: { path: "/prefs", methods: ["GET", "PATCH"] }, tpl: { path: "/u/{id}/prefs" }, kid: { path: "/kid", parent: "things" } },
};
const mockRoots = { "/d6/": d6, "/d7/": { ...d6, restep: "1.0-draft.7" }, "/v2/": { restep: "2.0", collections: { books: { path: "/books" } } } };
let seen = [];

test("borrador 6: versión, recurso suelto, valores desconocidos, id_from, anonymous e inherit", async (t) => {
  const ref = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(REF_PORT), RESTEP_TOKEN: "" }, stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((r) => ref.stdout.once("data", r));
  const mock = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, key: req.headers["idempotency-key"] ?? null, body });
    const send = (s, d) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(d)); };
    if (mockRoots[req.url]) return send(200, mockRoots[req.url]);
    if (req.url.startsWith("/d6/things")) return send(req.method === "POST" ? 201 : 200, { items: [], next: null, id: "n" });
    if (req.url === "/d6/prefs") return send(200, { theme: "dark" });
    send(404, { status: 404, code: "not_found", title: "Not found" });
  });
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  const clients = [];
  const open = (u, env) => { const c = mcp(u, env); clients.push(c); return c; };
  try {
    await t.test("acepta 1.0-draft.6 y usa el recurso suelto shop de la referencia (§1.1, §5.9)", async () => {
      const c = open(`http://localhost:${REF_PORT}/`);
      const names = (await c.rpc("tools/list")).result.tools.map((x) => x.name);
      assert.ok(names.includes("get_singleton") && names.includes("update_singleton"), names.join());
      const d = await c.tool("describe", {});
      assert.equal(d.json().restep, "1.0-draft.6");
      const g = await c.tool("get_singleton", { singleton: "shop" });
      assert.equal(g.isError, false); assert.equal(typeof g.json().body.name, "string");
      const f = await c.tool("get_singleton", { singleton: "shop", fields: ["name"] });
      assert.equal(f.json().body.max_reservations, undefined);
      const u = await c.tool("update_singleton", { singleton: "shop", patch: { name: g.json().body.name } });
      assert.equal(u.json().status, 200);
    });
    await t.test("subcolección con parent_ids, include, href, type y acciones contra la referencia (§4.2, §9, §11.1)", async () => {
      const c = open(`http://localhost:${REF_PORT}/`);
      const tools = (await c.rpc("tools/list")).result.tools;
      assert.ok(tools.find((x) => x.name === "list").inputSchema.properties.include, "list ofrece include con relations");
      // reviews cuelga de books: sin parent_ids no se puede; un libro que no existe da 404.
      const no = await c.tool("list", { collection: "reviews" });
      assert.ok(no.isError && /parent_ids/.test(no.text), no.text);
      const r = await c.tool("list", { collection: "reviews", parent_ids: ["7"] });
      assert.equal(r.json().status, 200); assert.ok(r.json().body.items.length >= 1);
      assert.equal((await c.tool("list", { collection: "reviews", parent_ids: ["no-existe"] })).json().status, 404);
      // include con profundidad 2; más hondo, o por una relación no incluible, falla antes de enviar.
      const p = await c.tool("list", { collection: "products", include: ["category.parent"] });
      assert.ok(p.json().body.items.some((x) => x.category?.parent?.name), p.text.slice(0, 300));
      const deep = await c.tool("list", { collection: "products", include: ["category.parent.parent"] });
      assert.ok(deep.isError && /include_depth/.test(deep.text), deep.text);
      const bad = await c.tool("get", { collection: "books", id: "7", include: ["editor"] });
      assert.ok(bad.isError && /Includable: author, related, highlight/.test(bad.text), bad.text);
      // highlight lleva a un elemento de reviews por su href; showcase, a books o products por su type.
      const b = await c.tool("get", { collection: "books", id: "7", include: ["highlight"] });
      const hl = b.json().body.highlight;
      assert.equal(hl.href, `/books/7/reviews/${hl.id}`);
      const [, , parent, , rid] = hl.href.split("/");
      assert.equal((await c.tool("get", { collection: "reviews", id: rid, parent_ids: [parent] })).json().body.text, hl.text);
      const cats = await c.tool("list", { collection: "categories", include: ["showcase"] });
      const shown = cats.json().body.items.map((x) => x.showcase).filter(Boolean);
      assert.ok(shown.length && shown.every((x) => ["books", "products"].includes(x.type)));
      for (const s of shown) assert.equal((await c.tool("get", { collection: s.type, id: s.id })).json().status, 200);
      // Acciones: GET de colección, POST de elemento con input, idempotentes.
      const low = await c.tool("action", { collection: "products", name: "low_stock" });
      assert.ok(!low.isError, low.text); assert.ok(low.json().body.items.every((x) => x.stock < 5), low.text.slice(0, 300));
      const before = (await c.tool("get", { collection: "products", id: "1" })).json().body.stock;
      const rs = await c.tool("action", { collection: "products", name: "restock", id: "1", body: { quantity: 2 }, idempotency_key: crypto.randomUUID() });
      assert.equal(rs.json().body.stock, before + 2);
      const inv = await c.tool("action", { collection: "products", name: "restock", id: "1", body: { quantity: 0 } });
      assert.equal(inv.json().status, 422);
      const f1 = await c.tool("action", { collection: "authors", name: "find_or_create", body: { name: "Autora de restep-mcp" } });
      const f2 = await c.tool("action", { collection: "authors", name: "find_or_create", body: { name: "Autora de restep-mcp" } });
      assert.deepEqual([f1.json().status, f2.json().status], [201, 200]);
      assert.equal(f1.json().body.id, f2.json().body.id);
      const it = await c.tool("action", { collection: "categories", name: "inherit_tax", id: "2" });
      assert.equal(it.json().status, 200);
      const wrong = await c.tool("action", { collection: "authors", name: "find_or_create", id: "1", body: { name: "x" } });
      assert.ok(wrong.isError && /collection/.test(wrong.text), wrong.text);
    });
    await t.test("otra versión mayor no es Restep 1 ni cae a core (§1.1)", async () => {
      assert.equal(restepVersionProblem("1.0-rc.1"), null);
      assert.match(restepVersionProblem("1.01"), /grammar/);
      const c = open(`http://127.0.0.1:${MOCK_PORT}/v2/`);
      const d = await c.tool("describe", {});
      assert.ok(d.isError && /not Restep 1/.test(d.text), d.text);
      const l = await c.tool("list", { collection: "books" });
      assert.ok(l.isError && /not Restep 1/.test(l.text), l.text);
      assert.ok(!seen.some((s) => s.url === "/v2/books"));
    });
    await t.test("valores desconocidos y recursos sueltos reservados no se usan (§4.2, §5.9)", async () => {
      const c = open(`http://127.0.0.1:${MOCK_PORT}/d6/`);
      const tools = (await c.rpc("tools/list")).result.tools;
      assert.deepEqual(tools.find((x) => x.name === "get_singleton").inputSchema.properties.singleton.enum, ["prefs"]);
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
    await t.test("id_from desconocido: no manda id (§5.1); anonymous false: sin clave (§7.1)", async () => {
      const c = open(`http://127.0.0.1:${MOCK_PORT}/d6/`);
      const tools = (await c.rpc("tools/list")).result.tools;
      assert.equal(tools.find((x) => x.name === "create").inputSchema.properties.idempotency_key, undefined);
      const a = await c.tool("create", { collection: "things", body: { id: "a", x: 1 } });
      assert.ok(a.isError && /id_from/.test(a.text), a.text);
      const k = await c.tool("create", { collection: "things", body: { x: 1 }, idempotency_key: "k" });
      assert.ok(k.isError && /anonymous/.test(k.text), k.text);
      seen = [];
      const b = await c.tool("create", { collection: "things", body: { x: 1 } });
      assert.equal(b.json().status, 201);
      assert.equal(seen[0].key, null);
      const withToken = open(`http://127.0.0.1:${MOCK_PORT}/d6/`, { RESTEP_TOKEN: "t" });
      const t2 = (await withToken.rpc("tools/list")).result.tools;
      assert.ok(t2.find((x) => x.name === "create").inputSchema.properties.idempotency_key);
    });
    await t.test("inherit experimental solo con el borrador que conoce (§1.2)", async () => {
      const a = open(`http://127.0.0.1:${MOCK_PORT}/d6/`);
      const ia = (await a.rpc("initialize", {})).result.instructions;
      assert.match(ia, /inherited values/); assert.match(ia, /other "from" as "hidden"/);
      const b = open(`http://127.0.0.1:${MOCK_PORT}/d7/`);
      const ib = (await b.rpc("initialize", {})).result.instructions;
      assert.doesNotMatch(ib, /inherited values/);
    });
  } finally {
    for (const c of clients) c.close();
    ref.kill();
    mock.close();
  }
});

test("solo se siguen enlaces https o con el esquema de la raíz (§3)", async () => {
  const fetch = async () => new Response("{}");
  const secure = new URL("https://api.example/");
  await assert.rejects(fetchApi(secure, "http://api.example/next", {}, { fetch }), /HTTPS/);
  await fetchApi(new URL("http://localhost/"), "http://localhost/next", {}, { fetch });
});
