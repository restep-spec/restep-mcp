# restep-mcp (prototipo)

Adaptador que expone cualquier API Restep 1 como servidor
[MCP](https://modelcontextprotocol.io), para que la usen Claude, ChatGPT u otros agentes.
Un solo archivo, Node 18+, sin dependencias. No forma parte de la especificación: es una
herramienta para probar la idea que salió del council sobre agentes (noviembre de 2026).

## Idea

En lugar de una herramienta por endpoint (que empeora la elección de herramienta cuanto más
crece la API), expone siempre las mismas, construidas a partir del documento de
descubrimiento (§4.2):

| Herramienta | Petición Restep | Anotaciones MCP |
|---|---|---|
| `describe` | `GET` de la raíz; con `collection`, solo esa colección | solo lectura |
| `list` | `GET /coleccion` con `filter`, `named_filters` (filtros con nombre, §6.1, sin operadores), `sort`, `fields`, `include` (con `relations`, §9), `limit`, `count`; o el `next` tal cual (§5.2) | solo lectura |
| `get` | `GET /coleccion/id`, con `fields` e `include` | solo lectura |
| `create` | `POST /coleccion`, con `Idempotency-Key` si se pasa | aditiva, no idempotente |
| `update` | `PATCH` con Merge Patch, con `If-Match` si se pasa | destructiva, idempotente |
| `delete` | `DELETE`, con `If-Match` si se pasa | destructiva, idempotente |
| `action` | `POST /coleccion/id:nombre` (solo con la extensión `actions`) | destructiva por defecto |
| `get_singleton` | `GET` de un recurso suelto (§5.9), con `fields` si hay `query` (solo si la API declara alguno) | solo lectura |
| `update_singleton` | `PATCH` de un recurso suelto, con `If-Match` si se pasa | destructiva, idempotente |

- El argumento `collection` es un `enum` con las colecciones del discovery, y las
  herramientas de `query` y `writes` solo ofrecen sus argumentos si el servidor anuncia el
  perfil.
- Los errores llegan al agente enteros, como `problem+json` y con `isError`. Las
  instrucciones del servidor le explican qué significan `unsupported_parameter` (no
  reintentar) e `invalid_parameter` (corregir y reintentar). Ante un `unsupported_parameter`,
  el adaptador añade `hint` con los filtros y claves de orden que sí ofrece la colección.
- `if_match` acepta el ETag con o sin comillas.
- Con `RESTEP_TOKEN`, solo las peticiones al origen de la API llevan `Authorization: Bearer`. Cada salto de redirección se comprueba; los enlaces de otro origen se leen sin credenciales. Las escrituras a otro origen y las redirecciones de escrituras se rechazan.
- Con `RESTEP_LANGUAGE` (por ejemplo `es`), cada petición lleva ese `Accept-Language`, así que los textos de la API (errores, descripciones del discovery) llegan en ese idioma si lo ofrece (§5.6). Los datos no cambian.
- Si alguna colección declara `language_maps` (§3), las descripciones de las herramientas explican los mapas de idioma: qué traducción mostrar sin inventar las que faltan, cómo filtrar por una traducción exacta (`name.es-mx`) y cómo se fusionan en un `update`.
- Si alguna colección declara `inherit` (§11.6) y la API anuncia la extensión con
  `"restep": "1.0-draft.6"`, explican que el campo efectivo es de solo lectura y que se escribe el propio (`null` para volver a heredar). Si el agente escribe el efectivo y recibe `read_only`, el adaptador añade `hint` con el campo que tiene que escribir.

## Uso

```bash
npx restep-mcp http://localhost:8080/          # MCP por stdio
npx restep-mcp http://localhost:8080/ --http   # MCP en http://127.0.0.1:8788/mcp
```

En Claude Code:

```bash
claude mcp add restep -- npx -y restep-mcp http://localhost:8080/
```

En la configuración JSON de otros clientes (Claude Desktop, Cursor…):

```json
{ "mcpServers": { "restep": { "command": "npx", "args": ["-y", "restep-mcp", "http://localhost:8080/"] } } }
```

## Límites

- El transporte HTTP es mínimo: responde cada `POST` con JSON, sin flujo SSE ni sesiones, y
  sin OAuth propio (solo escucha en `127.0.0.1` y rechaza `Origin` no locales).
- De `relations` solo expone `include` (§9): se comprueba antes de enviar que cada tramo sea una
  relación con `"include": true` y que la ruta no pase de `include_depth` (1 si no lo declara); una
  relación a varias colecciones solo puede ir al final. No expone `sync`, `batch`, `filter-expr`
  ni `query-method`.
- Ofrece `create`, `update` y `delete` para todas las colecciones. Los `methods`,
  `item_methods` y `schemas` del borrador 4 (§4.3) le llegan al agente a través de `describe`,
  pero el adaptador todavía no los usa para quitar herramientas ni para validar antes de enviar.
- Las acciones usan `POST`, salvo las declaradas con `"method": "GET"` (§11.1).
- Del borrador 6 no implementa: crear o enlazar relaciones con su `href` (el agente escribe el
  cuerpo; §5.1); interpretar `deprecations` o la cabecera `Deprecation` (llegan al agente tal
  cual en `describe` y en `headers`); `collations`, `reasons` y `parent` solo llegan en
  `describe`; `describe` con `collection` no acepta un recurso suelto (sale en el `describe`
  completo). Los textos de la API llegan al agente dentro del JSON del resultado de cada
  herramienta, que los delimita, pero no se marcan aparte (§4.3 lo pide como DEBERÍA). El
  adaptador solo hace las peticiones que pide el agente con sus herramientas: que el agente no
  haga una escritura solo porque se lo pida un texto de la API (§4.3) depende del agente; las
  instrucciones del servidor se lo recuerdan.

## Borrador 6: lo que hace como cliente (§12.2)

- **Versión (§1.1).** Acepta `restep` con sufijo. Si no sigue la gramática o la versión mayor no
  es 1, no es Restep 1: `describe` y las demás herramientas fallan con el motivo, sin suponer
  solo `core`.
- **Partes experimentales (§1.2).** Solo explica y da pistas de `inherit` con la extensión
  anunciada y `"restep": "1.0-draft.6"`; con otra versión, no. Un `from` desconocido en
  `_inherited` se explica como `"hidden"`. `sync`, `batch`, `filter-expr` y `query-method` no
  tienen herramienta.
- **Valores desconocidos (§4.2).** Un filtro o filtro con nombre con un `type` desconocido, un
  operador fuera de §6.1 y una acción con un `on` o un `method` desconocidos no se usan: la
  herramienta falla antes de enviar.
- **Recursos sueltos (§5.9).** `get_singleton` y `update_singleton`; se ignoran los que tienen
  plantilla en `path` o `parent`.
- **`id_from` (§5.1).** Con un valor desconocido, `create` no manda un cuerpo con `id`. La
  descripción de `create` explica `"client"` y `"either"`.
- **`idempotency.anonymous: false` (§7.1).** Sin `RESTEP_TOKEN`, `create` y `action` no ofrecen
  `idempotency_key` y la rechazan si llega.
- **Enlaces (§3).** Solo sigue enlaces `https` o con el esquema de la raíz; las credenciales
  solo van a su origen.

## Pruebas

`node --test tools/restep-mcp/test.mjs` (o `node tools/restep-mcp/test.mjs`) comprueba
credenciales por origen, redirecciones, bucles, esquemas de los enlaces y rechazo de escrituras
fuera del origen sin abrir puertos; y, de punta a punta por stdio, el borrador 6 contra el
servidor de referencia (puerto 8961) y un servidor simulado (8962): versión con sufijo, otra
versión mayor, el recurso suelto `shop`, valores desconocidos, `id_from`, `anonymous: false` e
`inherit` según el borrador declarado. Contra la referencia prueba también la subcolección
`reviews` con `parent_ids` (y su `404` sin libro), `include` con profundidad 2 y sus errores
locales, la relación `highlight` seguida por su `href`, la polimórfica `showcase` por su `type`, y
las acciones `low_stock` (`GET` de colección), `restock` (`POST` de elemento con `input`, y su `422`),
`find_or_create` e `inherit_tax` (idempotentes).

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-mcp>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
