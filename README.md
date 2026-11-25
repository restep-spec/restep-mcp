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
| `create` | `POST /collection`, with `Idempotency-Key` if given | not idempotent; destructive and open-world from the declared `effects` |
| `update` | `PATCH` with Merge Patch, with `If-Match` if given | idempotent; destructive and open-world from the declared `effects` |
| `delete` | `DELETE`, with `If-Match` if given | idempotent; destructive and open-world from the declared `effects` |
| `action` | `POST` or `GET` of `/collection/id:name`, `/collection:name` or `/singleton:name` (only with the `actions` extension) | from the declared `effects` |
| `get_singleton` | `GET` of a singleton (§5.9), with `parent_ids` for one under an item and `fields` if there is `query` (only if the API declares any) | read-only |
| `update_singleton` | `PATCH` of a singleton, with `parent_ids` and `If-Match` if given | idempotent; destructive and open-world from each singleton's `method_effects` (all three where undeclared) |

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
- If any collection declares `localized` (§3), the descriptions explain localized fields: read-only, in the language of the response; the language map is what is written. The adapter does not refuse a localized field in a write: the server decides (§5.1); if it answers `read_only`, the `hint` names the source map.
- If any collection declares `inherit` (§11.6) and the API announces the extension with
  `"restep": "1.0-draft.7"`, they explain that the effective field is read-only and that the own field is the one to write (`null` to inherit again). If the agent writes the effective field and gets `read_only`, the adapter adds a `hint` with the field it has to write.

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
- Actions use `POST`, except those declared with `"method": "GET"` (§11.1), which take `params` instead of a body.
- File uploads (`upload`, §5.1) are not sent: the descriptions say so, and an item's `_content.href` reaches the agent as a link.
  A collection with `upload` and without `schemas.create` takes only files, so `create` refuses it
  before sending; with both, `create` sends JSON as in any collection.
- Not implemented from draft 7: creating or linking relations with their `href` (the agent writes
  the body; §5.1); interpreting `deprecations` or the `Deprecation` header (they reach the agent
  as is in `describe` and in `headers`); `collations`, `reasons` and `parent` only arrive in
  `describe`; `describe` with `collection` does not accept a singleton (it appears in the full
  `describe`). The API's texts reach the agent inside the JSON result of each tool, which
  delimits them, but they are not marked separately (§4.3 asks for it as a SHOULD). The adapter
  only makes the requests the agent asks for with its tools: whether the agent refrains from a
  write just because an API text tells it to (§4.3) is up to the agent; the server instructions
  remind it.

## Draft 7: what it does as a client (§12.2)

- **Version (§1.1).** Accepts `restep` with a suffix. If it does not follow the grammar or the
  major version is not 1, it is not Restep 1: `describe` and the other tools fail with the
  reason, without assuming plain `core`.
- **Experimental parts (§1.2).** It only explains and gives hints about `inherit` with the
  extension announced and `"restep": "1.0-draft.7"`; with another version, it does not. A field
  of `inherit`, or an `inherit_items` declaration, with a member it does not know, other than an `x-` one (the
  server's own), is treated as not inherited. A safe action with an `effects` value it does not
  know counts as having all three, and is asked about. An
  unknown `from` in `_inherited` is explained as `"hidden"`. `sync`, `batch`, `filter-expr` and
  `query-method` have no tool.
- **Discovery (§4.2).** Only a `2xx` whose body has a string `restep` is a discovery document. It
  assumes `core` only after a `2xx` without one or a `404`; after another error (a `401`, a `503`)
  every tool fails with it and the next call reads discovery again. Of several `service-desc`
  links it uses the first target that is a discovery document of Restep 1.
- **Unknown values (§4.2).** A filter or named filter with an unknown `type`, a filter with an
  unknown `quantifier`, an operator outside §6.1 and an action with an unknown `on` or `method`
  are not used: the tool fails before sending. It knows `nin`, `prefix`, `contains`,
  `localdatetime`, `timezone` and `"quantifier": "some"`.
- **Effects (§4.3, §11.1, §13.1).** Before an unsafe operation (`create`, `update`, `delete`,
  `update_singleton`, an unsafe action) it asks a person when the operation declares an effect
  and also when it declares `[]`, unless `RESTEP_TRUST_EFFECTS=1` says the server is trusted; a
  safe action is asked about only when it declares `charges`. Without `effects`, or with a value
  it does not know, an operation has all three, also a safe action; an undeclared `DELETE` has
  `["destroys"]`; a singleton's `PATCH` has what its `method_effects` declares (§5.9), and all
  three where it is undeclared. It asks through MCP elicitation (`elicitation/create`) when
  the client offers it over stdio; otherwise the call fails, says which effects it has, and runs
  only when the agent repeats it with `"approved": true` after asking the user. Each tool's
  `destructiveHint` and `openWorldHint` follow `destroys` and `external` of the operations it runs.
- **Actions (§11.1).** A `GET` action takes `params` (checked against its declaration: undeclared,
  missing required, commas in a list), and none where it declares no `params` (§5.3: the API
  would answer `unsupported_parameter`); a safe action with `output` returns its result as
  `output`, not `body`. The description warns that a replayed response without `etag` may be the
  stored result, not the item's current state (§7.1). Singleton actions use `singleton` instead of `collection`. The `create`
  description points to the `new` action where a collection has it.
- **Filters (§6.1).** A default switch is turned off with `false` in `named_filters`; `false` on
  any other one fails before sending. The descriptions explain `"default": true`,
  `"required": true` and groups through a to-many path with `"quantifier": "some"`; `null` on the
  relationship or list field itself, as its only operator, declared with `"quantifier": "some"` or
  without it, is sent like any filter. They say that `null` under a `quantifier` tests the whole
  group (alone, empty, absent or `null`; with `in` or other filters on the group, `true` = no
  visible element matches all of them at once, `false` = some does), that only one `null` filter
  goes on the same relationship or list, its own or that of a path through it (the server answers
  `invalid_parameter`), and that `integer` and `number` operands follow
  the number grammar of RFC 8259 (`2e1` is `20`; never `+20`, `.5`, `020` or `0x14`). Filter
  values go as given (an `integer` operand such as `20.0` is valid, §6.1: the server decides). A
  JSON number of the request that a double cannot hold (`1e400`, `1e-400`,
  `12345678901234567891`) keeps its source text, so it is never sent as `Infinity`, `0` or another
  integer (§6.1; Node 21 or later, which gives the parser the source text).
  The `create` description says that a replay may carry no `etag`: the agent reads the item.
- **Collections without `GET` (§4.3).** `list` refuses them.
- **Errors (§5.4, §5.7).** For `408`, `421`, `425`, `429`, `503` and `request_in_progress` the
  `hint` says whether and how to repeat; a `code` outside the closed table (`http_418` and the
  like) gets a hint by the class of its status. A `415` keeps its `Accept-Post` in `headers` and
  its `hint` names the media types the resource takes (§5.1).
- **Idempotency keys (§5.7).** The adapter remembers the first use of each `idempotency_key` and
  refuses to repeat it after `idempotency.ttl` (24 hours where not declared); the message says to
  find out first whether the first attempt took effect, and that a create without an id of its
  own otherwise stays uncertain (§5.7).
- **Singletons (§5.9).** `get_singleton` and `update_singleton`, with `parent_ids` for a singleton
  under an item; one whose `path` is a template without `parent`, or whose `parent` names nothing
  in the document, is ignored.
- **`id_from` (§5.1).** With an unknown value, `create` does not send a body with `id`. The
  `create` description explains `"client"` and `"either"`.
- **`idempotency.anonymous: false` (§7.1).** Without `RESTEP_TOKEN`, `create` and `action` do not
  offer `idempotency_key` and reject it if it arrives.
- **Links (§3).** It only follows links that are `https` or use the root's scheme; credentials
  only go to its origin.

## Tests

`node --test tools/restep-mcp/test.mjs` (or `node tools/restep-mcp/test.mjs`) checks
per-origin credentials, redirects, loops, link schemes and the rejection of writes outside the
origin without opening ports; and, end to end over stdio, against the reference server and a
mock server (both on free ports the system picks; `RESTEP_REF=<file>` tests against another copy
of the reference): version with a suffix, another major version, the `shop` singleton, unknown
values, `id_from`, `anonymous: false`, `inherit` depending on the declared draft, and the draft 7
rules above (discovery after an error, `service-desc`, effects with and without elicitation,
`params` and `output`, singletons under an item and their actions, localized fields, default
filters, `quantifier`, the new operators, error codes, the key's `ttl`, unknown `inherit`
members and inherited items). Against the reference it also tests the `reviews` subcollection with `parent_ids` (and its
`404` without a book), `include` with depth 2 and its local errors, the `highlight` relation
followed through its `href`, the polymorphic `showcase` through its `type`, and the actions
`low_stock` (collection `GET`), `restock` (item `POST` with `input`, and its `422`),
`find_or_create` and `inherit_tax` (idempotent).

## Code and issues

Code and issues: <https://github.com/restep-spec/restep-mcp>. That repository is generated from the Restep
site, where the tool is developed alongside the [specification](https://w3id.org/restep/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.
