# restep-mcp (prototype)

Adapter that exposes any Restep 1 API as an [MCP](https://modelcontextprotocol.io) server, so
Claude, ChatGPT or other agents can use it.
A single file, Node 18+, no dependencies. It is not part of the specification: it is a tool to
try out the idea that came out of the council on agents (November 2026).

## Idea

Instead of one tool per endpoint (which makes tool choice worse the bigger the API gets), it
always exposes the same tools, built from the discovery document (§4.2):

| Tool | Restep request | MCP annotations |
|---|---|---|
| `describe` | `GET` of the root; with `collection`, only that collection | read-only |
| `list` | `GET /collection` with `filter`, `named_filters` (named filters, §6.1, no operators), `sort`, `fields`, `include` (with `relations`, §9), `limit`, `count`; or `next` as is (§5.2) | read-only |
| `get` | `GET /collection/id`, with `fields` and `include` | read-only |
| `create` | `POST /collection`, with `Idempotency-Key` if given | additive, not idempotent |
| `update` | `PATCH` with Merge Patch, with `If-Match` if given | destructive, idempotent |
| `delete` | `DELETE`, with `If-Match` if given | destructive, idempotent |
| `action` | `POST /collection/id:name` (only with the `actions` extension) | destructive by default |
| `get_singleton` | `GET` of a singleton (§5.9), with `fields` if there is `query` (only if the API declares any) | read-only |
| `update_singleton` | `PATCH` of a singleton, with `If-Match` if given | destructive, idempotent |

- The `collection` argument is an `enum` with the collections from discovery, and the `query`
  and `writes` tools only offer their arguments if the server announces the profile.
- Errors reach the agent whole, as `problem+json` and with `isError`. The server instructions
  explain what `unsupported_parameter` (do not retry) and `invalid_parameter` (fix and retry)
  mean. On an `unsupported_parameter`, the adapter adds a `hint` with the filters and sort keys
  the collection does offer.
- `if_match` accepts the ETag with or without quotes.
- With `RESTEP_TOKEN`, only requests to the API's origin carry `Authorization: Bearer`. Every redirect hop is checked; links on another origin are read without credentials. Writes to another origin and redirects of writes are rejected.
- With `RESTEP_LANGUAGE` (for example `es`), every request carries that `Accept-Language`, so the API's texts (errors, discovery descriptions) arrive in that language if it offers it (§5.6). The data does not change.
- If any collection declares `language_maps` (§3), the tool descriptions explain language maps: which translation to show without making up missing ones, how to filter by an exact translation (`name.es-mx`) and how they merge on an `update`.
- If any collection declares `inherit` (§11.6) and the API announces the extension with
  `"restep": "1.0-draft.6"`, they explain that the effective field is read-only and that the own field is the one to write (`null` to inherit again). If the agent writes the effective field and gets `read_only`, the adapter adds a `hint` with the field it has to write.

## Usage

```bash
npx restep-mcp http://localhost:8080/          # MCP over stdio
npx restep-mcp http://localhost:8080/ --http   # MCP at http://127.0.0.1:8788/mcp
```

In Claude Code:

```bash
claude mcp add restep -- npx -y restep-mcp http://localhost:8080/
```

In the JSON config of other clients (Claude Desktop, Cursor…):

```json
{ "mcpServers": { "restep": { "command": "npx", "args": ["-y", "restep-mcp", "http://localhost:8080/"] } } }
```

## Limits

- The HTTP transport is minimal: it answers each `POST` with JSON, with no SSE stream or
  sessions, and no OAuth of its own (it only listens on `127.0.0.1` and rejects non-local
  `Origin`).
- Of `relations` it only exposes `include` (§9): before sending it checks that each step is a
  relation with `"include": true` and that the path is no deeper than `include_depth` (1 if not
  declared); a relation to several collections can only come last. It does not expose `sync`,
  `batch`, `filter-expr` or `query-method`.
- It offers `create`, `update` and `delete` for every collection. The draft 4 `methods`,
  `item_methods` and `schemas` (§4.3) reach the agent through `describe`, but the adapter does not
  yet use them to remove tools or to validate before sending.
- Actions use `POST`, except those declared with `"method": "GET"` (§11.1).
- Not implemented from draft 6: creating or linking relations with their `href` (the agent writes
  the body; §5.1); interpreting `deprecations` or the `Deprecation` header (they reach the agent
  as is in `describe` and in `headers`); `collations`, `reasons` and `parent` only arrive in
  `describe`; `describe` with `collection` does not accept a singleton (it appears in the full
  `describe`). The API's texts reach the agent inside the JSON result of each tool, which
  delimits them, but they are not marked separately (§4.3 asks for it as a SHOULD). The adapter
  only makes the requests the agent asks for with its tools: whether the agent refrains from a
  write just because an API text tells it to (§4.3) is up to the agent; the server instructions
  remind it.

## Draft 6: what it does as a client (§12.2)

- **Version (§1.1).** Accepts `restep` with a suffix. If it does not follow the grammar or the
  major version is not 1, it is not Restep 1: `describe` and the other tools fail with the
  reason, without assuming plain `core`.
- **Experimental parts (§1.2).** It only explains and gives hints about `inherit` with the
  extension announced and `"restep": "1.0-draft.6"`; with another version, it does not. An
  unknown `from` in `_inherited` is explained as `"hidden"`. `sync`, `batch`, `filter-expr` and
  `query-method` have no tool.
- **Unknown values (§4.2).** A filter or named filter with an unknown `type`, an operator outside
  §6.1 and an action with an unknown `on` or `method` are not used: the tool fails before
  sending.
- **Singletons (§5.9).** `get_singleton` and `update_singleton`; those with a template in `path`
  or with `parent` are ignored.
- **`id_from` (§5.1).** With an unknown value, `create` does not send a body with `id`. The
  `create` description explains `"client"` and `"either"`.
- **`idempotency.anonymous: false` (§7.1).** Without `RESTEP_TOKEN`, `create` and `action` do not
  offer `idempotency_key` and reject it if it arrives.
- **Links (§3).** It only follows links that are `https` or use the root's scheme; credentials
  only go to its origin.

## Tests

`node --test tools/restep-mcp/test.mjs` (or `node tools/restep-mcp/test.mjs`) checks
per-origin credentials, redirects, loops, link schemes and the rejection of writes outside the
origin without opening ports; and, end to end over stdio, draft 6 against the reference server
(port 8961) and a mock server (8962): version with a suffix, another major version, the `shop`
singleton, unknown values, `id_from`, `anonymous: false` and `inherit` depending on the declared
draft. Against the reference it also tests the `reviews` subcollection with `parent_ids` (and its
`404` without a book), `include` with depth 2 and its local errors, the `highlight` relation
followed through its `href`, the polymorphic `showcase` through its `type`, and the actions
`low_stock` (collection `GET`), `restock` (item `POST` with `input`, and its `422`),
`find_or_create` and `inherit_tax` (idempotent).

## Code and issues

Code and issues: <https://github.com/restep-spec/restep-mcp>. That repository is generated from the Restep
site, where the tool is developed alongside the [specification](https://restep.wubytes.com/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.
