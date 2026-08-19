# informer-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Informer](https://www.informer.nl) bookkeeping API (v2). It gives any MCP client direct
access to your relations, sales and purchase invoices, quotations, orders, receipts,
products and financial reports.

Every tool is derived from Informer's own OpenAPI document
([`api.informer.eu/docs/v2`](https://api.informer.eu/docs/v2/)). A copy ships with the
server so it works offline, and it keeps itself current — see
[Keeping up with API changes](#keeping-up-with-api-changes).

> Unofficial project. Not affiliated with or endorsed by Informer.

---

## Quickstart

Paste this into any AI assistant that can install MCP servers:

```text
Install the following MCP server: https://github.com/vladxyz/informer-mcp and run the local setup screen for the API keys.
```

It clones the repository, builds it, registers the server, and opens the page where your
API credentials go. Nothing is asked for in the chat, and no key is ever pasted into a
conversation.

To do it yourself, first build the server:

```bash
git clone https://github.com/vladxyz/informer-mcp.git
cd informer-mcp
npm install          # also builds dist/
```

Then wire it into whichever client you use. All of them run the same thing: `node`, with
the path to `dist/index.js`.

### Claude Code

```bash
claude mcp add informer -- node /absolute/path/to/informer-mcp/dist/index.js
```

Add `--read-only` at the end for a server that cannot change anything.

### Claude Desktop

Build a bundle and open it:

```bash
npm run bundle       # writes informer-mcp.mcpb
```

**Settings → Extensions → Advanced settings → Install Extension…** and pick the file. It
carries its own dependencies, and the install dialog asks for an API key, a security code
and a read-only switch — all three may be left empty, in which case the setup page opens
on first run.

> *Settings → Connectors → Add custom connector* is a different thing: it takes the URL of
> a remote MCP server. This one runs locally, so it installs as an extension.

Editing `claude_desktop_config.json` by hand works too — see
[Any MCP client](#any-mcp-client) for the shape, and put the file at
`~/Library/Application Support/Claude/` on macOS or `%APPDATA%\Claude\` on Windows.

### Codex and the ChatGPT desktop app

Codex CLI, the ChatGPT desktop app and the Codex IDE extension share one MCP
configuration:

```bash
codex mcp add informer -- node /absolute/path/to/informer-mcp/dist/index.js
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.informer]
command = "node"
args = ["/absolute/path/to/informer-mcp/dist/index.js"]
```

The `.mcpb` bundle is a Claude Desktop format; everywhere else use the command above.

### Any MCP client

The server speaks MCP over stdio, which every client configures the same way — a command
and its arguments:

```json
{
  "mcpServers": {
    "informer": {
      "command": "node",
      "args": ["/absolute/path/to/informer-mcp/dist/index.js"]
    }
  }
}
```

On Windows, either double the backslashes or use forward slashes.

Credentials do not belong in this file: they live in `~/.informer-mcp.json`, written by
the setup page. To pass them per client anyway, add an `env` block with
`INFORMER_API_KEY` and `INFORMER_SECURITY_CODE`.

### First run

However you installed it, starting without credentials opens the setup page by itself.
Then ask *"which administrations do you have access to?"* to confirm — that calls
`list_administrations` and lists each alias with its company.

---

## What you get

- **68 tools** covering all 49 documented endpoints — read *and* write.
- **Setup in the browser.** Ask your assistant to open the setup page, or run
  `informer-mcp setup`. It checks every key against the API, writes the config file, and
  the change takes effect without restarting anything.
- **Follows the API.** When Informer publishes a new endpoint the server picks it up and
  adds the tool while your client stays connected — no reinstall, no restart.
- **Several client administrations in one server.** Bookkeepers can reach every
  client's books from one connection, with an `administration` argument that is
  *required* whenever more than one is configured.
- **One question across the whole portfolio.** Read-only tools accept a list of
  aliases or `"all"` and query them concurrently, returning results keyed by client.
- **Full request schemas.** Create/update tools advertise the complete JSON Schema
  for their payload, so the model knows which fields exist and which are required
  before it sends anything.
- **Read-only or read-write, your choice.** A `--read-only` flag hides every tool that
  changes anything, and individual clients can be pinned to read-only while the rest
  stay writable. Allow/deny lists narrow the surface further.
- **PDFs and attachments** are decoded from base64 and can be written straight to disk.
- **Resilient HTTP.** Timeouts, retries with `Retry-After` support, and Informer's
  Dutch validation errors surfaced verbatim (`HTTP 422: invoice_date: ongeldig`).

## Requirements

- Node.js 20 or newer
- An InformerOnline account with API access

## Setting up your credentials

Just ask, in the conversation:

> *"I want to change my Informer administrations"*
> *"Add a new client to Informer"*
> *"My Informer API key changed"*

Your assistant calls the `open_setup` tool and the page opens. There is no config file to
find and nothing to edit by hand — and because the page is a browser form, your API key
never has to be typed into a chat. The same page from a terminal:

```bash
npm run setup          # or: informer-mcp setup
```

Starting the server with no credentials at all opens it automatically, since that is
exactly the moment you need it. Set `INFORMER_AUTO_SETUP=false` to turn that off, or
`INFORMER_OPEN_BROWSER=false` on a headless machine to only print the URL. However it was
opened, there is only ever one page: asking again hands back the same URL.

### What you see on the page

One card per administration, plus **Add administration** if you look after more than one:

```
┌─ Administration ────────────────────────────── Remove ─┐
│  ALIAS                        COMPANY NAME             │
│  [ acme                ]      [ ACME BV           ]    │
│  Short handle you use         Optional, shown in       │
│  in prompts.                  tool descriptions.       │
│                                                        │
│  API KEY                      SECURITY CODE            │
│  [ •••••••••••••••••  ]      [ •••••••••••••••  ]     │
│                                                        │
│  ACCESS                                                │
│  [ Read and write   ▾ ]                                │
│  Read only hides every tool that changes this          │
│  client's books.                                       │
└────────────────────────────────────────────────────────┘

  [ Add administration ]   [ Verify & save ]   ☐ Save without verifying
```

| Field | What to put in it |
| --- | --- |
| **Alias** | The short name you will say in prompts — *"list open invoices for **acme**"*. Letters, digits, `-` and `_`. |
| **Company name** | Optional label, shown to the model so it knows `acme` is ACME BV. |
| **API key** | Created inside that administration at [app.informer.eu/settings/api](https://app.informer.eu/settings/api/). |
| **Security code** | Shown in that administration's settings at [app.informer.eu/settings/account](https://app.informer.eu/settings/account/). |
| **Access** | *Read and write*, or *Read only* to hide every tool that could change this client's books. |

Both credentials belong to **one** administration, so a bookkeeper adds one card per
client. See [Multiple client administrations](#multiple-client-administrations).

### What happens when you press Verify & save

1. Each key/security-code pair is tried against the API, and the page shows you the
   company name it actually belongs to — so a key pasted into the wrong row is obvious
   before anything is stored.
2. If a pair is rejected, nothing is written and the failing row is named. Tick *Save
   without verifying* to store it anyway, for instance when you are offline.
3. On success the credentials are written to `~/.informer-mcp.json` with `0600`
   permissions. Opened through `open_setup`, the running server picks the change up
   immediately — a new administration is selectable in the very next message. Opened from
   a terminal, restart your client.

A few things the page deliberately does:

- it binds to `127.0.0.1` only, and every run generates a random token that must be in
  the URL and in the save request, so another site in your browser cannot post to it;
- it never sends stored keys back to the page — existing administrations show up with
  their credentials blank and are kept unless you type a new value;
- it refuses to save credentials the API rejects, unless you tick *Save without
  verifying*.

Nothing stops you from writing the file or the environment variables by hand; the page is
a convenience, not a requirement.

### Where the keys come from

The API authenticates with two headers, both required:

| Environment variable | Where to find it |
| --- | --- |
| `INFORMER_API_KEY` | [app.informer.eu/settings/api](https://app.informer.eu/settings/api/) |
| `INFORMER_SECURITY_CODE` | [app.informer.eu/settings/account](https://app.informer.eu/settings/account/) |

Both are scoped to **one administration**: the API key belongs to the administration it
was created in (`GET /administration` returns "the administration linked to this API
key") and the security code identifies that company. There is no endpoint that lists
administrations or switches between them.

A key grants full access to that administration's books. Treat it like a password: keep
it in your environment, a secret manager, or a config file outside the repository.

### Multiple client administrations

A bookkeeper with several clients needs one key/security-code pair per client
administration — an [accountant user](https://www.informer.nl/boekhoudprogramma/accountant)
with access to an administration can create them from its settings. Add them in the setup
page, or write `~/.informer-mcp.json` (or any file named by `INFORMER_CONFIG_FILE`)
yourself:

```json
{
  "administrations": {
    "acme":     { "label": "ACME BV",         "api_key": "...", "security_code": "..." },
    "bakkerij": { "label": "Bakkerij de Bol", "api_key": "...", "security_code": "...", "mode": "read-only" }
  }
}
```

With more than one administration configured, **every tool requires an `administration`
argument**, advertised as an enum of your aliases:

```jsonc
list_sales_invoices({ "administration": "acme", "filter": "open" })
```

There is deliberately no default. Booking an invoice into the wrong client's ledger is
the one mistake that must not happen quietly, so a call without the argument is rejected
by schema validation before any HTTP request is made — as is an alias you never
configured.

`list_administrations` shows the configured aliases; pass `verify: true` to fetch each
company name from the API, which confirms both that the credentials work and that every
alias points at the company you think it does.

#### Querying several clients at once

Read-only tools also accept a list of aliases, or `"all"`:

```jsonc
list_sales_invoices({ "administration": "all", "filter": "open", "records": 50 })
list_sales_invoices({ "administration": ["acme", "bakkerij"], "filter": "open" })
```

The administrations are queried concurrently (`INFORMER_FANOUT_CONCURRENCY`, four at a
time by default) and the answer is keyed by alias:

```json
{
  "administrations": ["acme", "bakkerij"],
  "results": {
    "acme": { "pagination": { "total": 3 }, "invoices": [ ... ] },
    "bakkerij": { "error": "[bakkerij] HTTP 401: Authentication failed" }
  }
}
```

Three properties worth knowing:

- **One client failing does not sink the query.** Its entry carries an `error` and the
  rest still return data.
- **The response budget is split evenly.** Each administration gets
  `INFORMER_MAX_RESPONSE_CHARS / n` characters, so one large client cannot crowd the
  others out; anything over its share comes back as `{ "truncated": true, "partial": ... }`.
- **Fan-out is read-only.** Tools that write, and the PDF/attachment downloads, take a
  single alias — their schema does not even offer the array or `"all"`, and the handler
  refuses them a second time. Creating the same invoice in twelve administrations is
  never an accident worth enabling.

A single administration still returns the API payload unwrapped, exactly as before.

With a single administration — the common case — nothing changes: set `INFORMER_API_KEY`
and `INFORMER_SECURITY_CODE` as usual and the argument stays optional.

## Read-only or read-write

By default every tool is available. To take the writing tools away entirely, start the
server with a flag:

```bash
informer-mcp --read-only     # only the tools that read
informer-mcp --read-write    # the default: create, update and delete too
```

`INFORMER_READ_ONLY=true` does the same thing, and the flag wins over the variable — so
you can register the same server twice in one client, once read-only for everyday
questions and once read-write for the sessions where you actually book something.

In read-only mode the write tools are not registered at all: they never appear in the
tool list, so there is nothing for a model to reach for.

### Per client

Individual administrations can be pinned in the config file, which is the useful shape
when you may only look at some clients' books:

```json
{
  "administrations": {
    "acme":     { "api_key": "...", "security_code": "..." },
    "bakkerij": { "api_key": "...", "security_code": "...", "mode": "read-only" }
  }
}
```

`"read_only": true` works as a shorthand. **The most restrictive setting wins:**

| Server | Client | Result |
| --- | --- | --- |
| `--read-write` (default) | *unset* | read-write |
| `--read-write` | `"read-only"` | read-only |
| `--read-only` | *unset* | read-only |
| `--read-only` | `"read-write"` | **read-only** — the flag clamps everything |

So a client marked read-only can never be written to by accident, and a session started
`--read-only` stays that way no matter what the config file says.

When some administrations are writable and others are not, the write tools stay
registered but their `administration` enum only offers the writable ones. Asking to
create an invoice in a read-only client is refused before any HTTP request:

```
Administration(s) bakkerij are configured as read-only, so this tool cannot change them.
Writable: acme, garage.
```

`list_administrations` reports the effective mode of each client, and the startup banner
summarises it: `read-write: acme, garage`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `INFORMER_API_KEY` | — | API key for a single administration. |
| `INFORMER_SECURITY_CODE` | — | Security code for that administration. |
| `INFORMER_CONFIG_FILE` | `~/.informer-mcp.json` | JSON file listing several administrations. Created by `setup` if absent. |
| `INFORMER_ADMINISTRATIONS` | — | The same JSON inline, as an environment variable. Overrides the file per alias. |
| `INFORMER_ADMINISTRATION_ALIAS` | `default` | Alias for the single `INFORMER_API_KEY` pair. |
| `INFORMER_ADMINISTRATION_LABEL` | — | Human-readable name for that alias. |
| `INFORMER_ADMINISTRATION_MODE` | — | `read-only` or `read-write` for that alias. |
| `INFORMER_BASE_URL` | `https://api.informer.eu/v2` | Override the API root. |
| `INFORMER_READ_ONLY` | `false` | `true` exposes only GET tools, for every administration. Same as `--read-only`. |
| `INFORMER_TOOLS` | *(all)* | Allowlist of tags and/or tool names, comma separated. |
| `INFORMER_EXCLUDE_TOOLS` | *(none)* | Denylist, applied after the allowlist. |
| `INFORMER_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `INFORMER_MAX_RETRIES` | `2` | Retries for 408/429/5xx and network errors. |
| `INFORMER_MAX_RESPONSE_CHARS` | `100000` | Longer tool results are truncated with a notice. Split evenly across a fan-out query. |
| `INFORMER_FANOUT_CONCURRENCY` | `4` | How many administrations a fan-out query hits at the same time. |
| `INFORMER_AUTO_SETUP` | `true` | `false` stops the setup page from opening when no credentials are configured. |
| `INFORMER_OPEN_BROWSER` | `true` | `false` prints the setup URL instead of launching a browser. |
| `INFORMER_SPEC_MAX_AGE_HOURS` | `24` | How old the cached API description may get before a background refresh. `0` disables it. |
| `INFORMER_SPEC_CACHE` | `~/.informer-mcp.spec.json` | Where the downloaded API description is cached. |
| `INFORMER_SPEC_URL` | Informer's published document | Override the API description to download. |

Filters accept either an OpenAPI tag or a tool name, and are matched case- and
punctuation-insensitively:

```bash
# read-only access to invoicing data
INFORMER_TOOLS="Sales Invoices,Relations" node dist/index.js --read-only

# everything except deleting attachments
INFORMER_EXCLUDE_TOOLS=delete_sales_invoice_attachment node dist/index.js
```

## Using it

Once connected, ask in plain language:

- *"Which sales invoices from 2026 are still unpaid?"* → `list_sales_invoices` with `filter`
- *"Create a draft invoice for ACME for 10 hours of consultancy at €125."* →
  `get_sales_invoice_options` for valid ledger/VAT/template ids, then `create_sales_invoice`
- *"Download invoice 12345 as a PDF to my desktop."* → `get_sales_invoice_pdf` with `save_path`
- *"Show the balance sheet for period 6 of 2026."* → `get_balance_report`

### Conventions worth knowing

- **Pick the administration explicitly.** With several clients configured, every tool
  takes `administration: "<alias>"`. `list_administrations` maps aliases to companies,
  and read-only tools also accept a list or `"all"`.
- **Dates** are always `YYYY-MM-DD`.
- **List tools are paginated** through `page` (default 1) and `records` (default 20),
  and return a `pagination` object with `total` and `pages`.
- **Request payloads go in a single `body` argument.** Path and query parameters stay
  at the top level, so `update_relation` takes `{ "id": 42, "body": { ... } }`.
- **Call the `*_options` tool first** when creating documents. `get_sales_invoice_options`,
  `get_quotation_options` and friends return the valid ledger, VAT, template, currency and
  payment-condition ids for your administration.
- **Reports need explicit ranges.** `get_balance_report` requires `year_from`, `year_to`
  and `period`; `get_column_balance_report` also wants a ledger range.

### PDFs and attachments

Informer returns files as base64 inside JSON. Tools that do this
(`get_*_pdf`, `download_sales_invoice_attachment`) take an optional `save_path`:

- **with** `save_path` — the file is decoded and written to that path, and the tool
  returns `{ saved_to, filename, bytes, mime_type }`;
- **without** it — the file comes back as an inline MCP resource with the right MIME
  type, which large documents can make expensive in context.

Uploading works the other way around: `upload_sales_invoice_attachment` takes
`{ filename, file }` where `file` is base64-encoded content (max 10 MB; PDF, PNG,
JPEG, GIF, DOC(X), XLS(X)).

## Tool reference

`npm run tools` prints this list from the current spec; `npm run tools -- --md`
regenerates the tables below.

Besides the endpoint tools there are three server-provided ones:

| Tool | What it does |
| --- | --- |
| `list_administrations` | Which client administrations are configured, their companies, and which may be written to. |
| `open_setup` | Opens the local page for adding, changing or removing administrations and their credentials. |
| `refresh_api_spec` | Re-reads Informer's API description and updates the tools. |

<details>
<summary><strong>All 68 endpoint tools, grouped by API area</strong></summary>

### Administration

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_administration` | `GET /administration` | Get administration details |

### Relations

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_relation` | `GET /relations/{id}` | Get a single relation |
| `update_relation` | `PUT /relations/{id}` | Update a relation |
| `list_relations` | `GET /relations` | Get a list of relations |
| `create_relation` | `POST /relations` | Create a new relation |

### Contacts

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_contact` | `GET /contact/{id}` | Get a single contact |
| `update_contact` | `PUT /contact/{id}` | Update a contact |
| `create_contact` | `POST /contact` | Create a new contact |

### Sales Invoices

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_sales_invoice` | `GET /invoices/sales/{id}` | Get a single sales invoice |
| `update_sales_invoice` | `PUT /invoices/sales/{id}` | Update a sales invoice |
| `list_sales_invoices` | `GET /invoices/sales` | Get a list of sales invoices |
| `create_sales_invoice` | `POST /invoices/sales` | Create a new sales invoice |
| `get_sales_invoice_options` | `GET /invoices/sales/options` | Get sales invoice options |
| `get_sales_invoice_pdf` | `GET /invoices/sales/pdf/{id}` | Get sales invoice PDF |
| `send_sales_invoice` | `POST /invoices/sales/send/{id}` | Send a sales invoice |
| `upload_sales_invoice_attachment` | `POST /invoices/sales/{id}/attachments` | Upload an invoice-specific attachment |
| `download_sales_invoice_attachment` | `GET /invoices/sales/{id}/attachments/{attachment_id}` | Download an invoice attachment |
| `delete_sales_invoice_attachment` | `DELETE /invoices/sales/{id}/attachments/{attachment_id}` | Delete an invoice-specific attachment |

### Purchase Invoices

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_purchase_invoice` | `GET /invoices/purchase/{id}` | Get a single purchase invoice |
| `list_purchase_invoices` | `GET /invoices/purchase` | Get a list of purchase invoices |
| `create_purchase_invoice` | `POST /invoices/purchase` | Create a new purchase invoice |
| `get_purchase_invoice_options` | `GET /invoices/purchase/options` | Get purchase invoice options |
| `get_purchase_invoice_pdf` | `GET /invoices/purchase/pdf/{id}` | Get purchase invoice PDF |

### Recurring Invoices

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_recurring_invoice` | `GET /invoices/recurring/{id}` | Get a single recurring invoice |
| `update_recurring_invoice` | `PUT /invoices/recurring/{id}` | Update a recurring invoice |
| `list_recurring_invoices` | `GET /invoices/recurring` | Get a list of recurring invoices |
| `create_recurring_invoice` | `POST /invoices/recurring` | Create a new recurring invoice |
| `get_recurring_invoice_options` | `GET /invoices/recurring/options` | Get recurring invoice options |

### Sales Orders

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_sales_order` | `GET /orders/sales/{id}` | Get a single sales order |
| `update_sales_order` | `PUT /orders/sales/{id}` | Update a sales order |
| `list_sales_orders` | `GET /orders/sales` | Get a list of sales orders |
| `create_sales_order` | `POST /orders/sales` | Create a new sales order |
| `get_sales_order_options` | `GET /orders/sales/options` | Get sales order options |
| `get_sales_order_pdf` | `GET /orders/sales/pdf/{id}` | Get sales order PDF |
| `send_sales_order` | `POST /orders/sales/send/{id}` | Send a sales order |

### Quotations

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_quotation` | `GET /quotations/{id}` | Get a single quotation |
| `update_quotation` | `PUT /quotations/{id}` | Update a quotation |
| `list_quotations` | `GET /quotations` | Get a list of quotations |
| `create_quotation` | `POST /quotations` | Create a new quotation |
| `get_quotation_options` | `GET /quotations/options` | Get quotation options |
| `get_quotation_pdf` | `GET /quotations/pdf/{id}` | Get quotation PDF |
| `send_quotation` | `POST /quotations/send/{id}` | Send a quotation |

### Salesbook

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_salesbook_invoice` | `GET /salesbook/{id}` | Get a single salesbook invoice |
| `update_salesbook_invoice` | `PUT /salesbook/{id}` | Update a salesbook invoice |
| `list_salesbook_invoices` | `GET /salesbook` | Get a list of salesbook invoices |
| `create_salesbook_invoice` | `POST /salesbook` | Create a new salesbook invoice |
| `get_salesbook_invoice_options` | `GET /salesbook/options` | Get salesbook options |
| `get_salesbook_invoice_pdf` | `GET /salesbook/pdf/{id}` | Get salesbook PDF |

### Payment Conditions

| Tool | Endpoint | Description |
| --- | --- | --- |
| `list_payment_conditions` | `GET /payment-conditions` | Get all payment conditions |

### Templates

| Tool | Endpoint | Description |
| --- | --- | --- |
| `list_templates` | `GET /templates` | Get all templates |

### VAT

| Tool | Endpoint | Description |
| --- | --- | --- |
| `list_vat_options` | `GET /vat` | Get all VAT options |

### Ledgers

| Tool | Endpoint | Description |
| --- | --- | --- |
| `list_ledgers` | `GET /ledgers` | Get all ledger accounts |

### Costs

| Tool | Endpoint | Description |
| --- | --- | --- |
| `list_cost_centres` | `GET /costs` | Get all cost centre accounts |

### Currencies

| Tool | Endpoint | Description |
| --- | --- | --- |
| `list_currencies` | `GET /currencies` | Get all currencies |

### Journals

| Tool | Endpoint | Description |
| --- | --- | --- |
| `list_journals` | `GET /journals` | Get all journals |

### Subscription types

| Tool | Endpoint | Description |
| --- | --- | --- |
| `list_subscription_types` | `GET /subscription-types` | Get all subscription types |

### Attachments

| Tool | Endpoint | Description |
| --- | --- | --- |
| `list_attachments` | `GET /attachments` | Get all attachments |

### Products

| Tool | Endpoint | Description |
| --- | --- | --- |
| `list_products` | `GET /products` | Get all products |

### Receipts

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_receipt` | `GET /receipts/{id}` | Get a single receipt |
| `update_receipt` | `PUT /receipts/{id}` | Update a receipt |
| `list_receipts` | `GET /receipts` | Get a list of receipts |
| `create_receipt` | `POST /receipts` | Create a new receipt |

### Memorandum

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_memorandum_entry` | `GET /memorandum/{id}` | Get a single memorandum entry |
| `update_memorandum_entry` | `PUT /memorandum/{id}` | Update a memorandum entry |
| `list_memorandum_entries` | `GET /memorandum` | Get a list of memorandum entries |
| `create_memorandum_entry` | `POST /memorandum` | Create a new memorandum entry |

### Reports

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_balance_report` | `GET /reports/balance` | Get balance sheet |
| `get_column_balance_report` | `GET /reports/column-balance` | Get column balance |

</details>

### Tool naming

Names are derived from the HTTP method and path, not from prose, so they stay stable
across spec updates:

| Pattern | Example |
| --- | --- |
| `GET /resources` | `list_relations` |
| `GET /resources/{id}` | `get_relation` |
| `POST /resources` | `create_relation` |
| `PUT /resources/{id}` | `update_relation` |
| `GET /resources/options` | `get_sales_invoice_options` |
| `GET /resources/pdf/{id}` | `get_sales_invoice_pdf` |
| `POST /resources/send/{id}` | `send_quotation` |

Endpoints the naming table does not recognise fall back to `<verb>_<path slug>`, so a
spec refresh never produces a broken tool.

## Keeping up with API changes

The tools are generated from Informer's OpenAPI document, so when Informer adds an
endpoint the only thing missing is a fresh copy of that document. The server can fetch
it itself.

Three layers, in order of precedence:

1. **A downloaded copy**, cached at `~/.informer-mcp.spec.json`.
2. **The bundled copy** in `openapi/api-docs.json`, which ships with the server and
   always works offline.
3. Neither is ever trusted blindly — a download must parse as an OpenAPI 3 document with
   at least one usable operation, or it is rejected and the current tools stay. A captive
   portal or a maintenance page cannot wipe your tool set.

### On a schedule

Once a day, shortly after starting, the server checks for a newer document in the
background. Startup is never blocked and a failed check is logged and ignored.
`INFORMER_SPEC_MAX_AGE_HOURS=0` turns it off.

### On demand

The `refresh_api_spec` tool does the same thing when you ask for it — useful when an
endpoint you expect is missing, or an argument is rejected as unknown:

> *"Refresh the Informer API description and tell me what changed."*

```json
{
  "adopted": true,
  "api_version": "2.0.0",
  "endpoints": 49,
  "tools": 68,
  "changes": {
    "added":   [{ "tool": "list_projects", "endpoint": "GET /projects" }],
    "removed": [],
    "changed": [{ "tool": "create_sales_invoice", "endpoint": "POST /invoices/sales",
                  "notes": ["body now requires: project_id"] }],
    "unchanged": 66
  },
  "note": "The tool list has been updated; no restart is needed."
}
```

Pass `dry_run` to see that report without applying anything.

The diff is deliberately specific: it names the tools that appeared and disappeared, and
for the ones that changed it says *what* changed — a new argument, one that is gone, a
field that is now required. That is the part a bare path comparison misses, and it is
usually the part that would otherwise surface as a puzzling `422`.

Adopting a document updates the running server: new tools are registered, withdrawn ones
are removed, changed ones are re-advertised, and a `tools/list_changed` notification goes
out so your client reloads the list mid-session.

### The copy in the repository

`npm run update-spec` updates the *bundled* document and reports which paths came and
went. That is the one to run when you want the change committed for everyone who installs
the server; `refresh_api_spec` only affects your own machine.

## Resources

The server also exposes the OpenAPI document itself as an MCP resource at
`informer://openapi.json`, which is handy when you want the model to check a field
definition without guessing.

## Development

```bash
npm install         # install + build
npm run setup       # enter credentials in the browser
npm run bundle      # package as informer-mcp.mcpb for one-click install
npm run dev         # run from source with tsx
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
npm run tools       # print the tool surface
npm run update-spec # re-download openapi/api-docs.json and report added/removed paths
```

### Project layout

```
openapi/api-docs.json   vendored OpenAPI 3.0 document — the source of truth
src/openapi.ts          spec → operations: tool names, JSON Schema conversion
src/client.ts           HTTP client: auth headers, retries, error formatting
src/tools.ts            operations → MCP tools, filtering, result formatting
src/server.ts           server assembly (tools + openapi resource)
src/spec.ts             download, validate, cache and diff the OpenAPI document
src/setup.ts            local setup server: verify credentials, write the config file
src/setup-page.ts       the HTML it serves
src/index.ts            stdio entry point and CLI
manifest.json           extension manifest: entry point and install-time settings
scripts/update-spec.mjs refresh the vendored spec
scripts/list-tools.ts   print/regenerate the tool reference
scripts/bundle.mjs      stage production dependencies and pack the .mcpb
```

Adding endpoints is normally not a code change at all — the running server picks them up
by itself, and `npm run update-spec` commits the same change to the bundled copy. Only
genuinely new URL shapes need a rule in the `RESOURCES` table in `src/openapi.ts`;
without one they still become tools, just with a duller name.

### How schemas are converted

OpenAPI 3.0 is not quite JSON Schema. On the way to the MCP tool definition:

- `#/components/schemas/X` references become `#/$defs/X`, with only the transitive
  closure each operation actually needs inlined — so tool definitions stay small;
- `nullable: true` becomes a `["type", "null"]` union;
- path and query parameters become top-level properties, request bodies go under `body`,
  and `additionalProperties: false` keeps typos from reaching the API.

Arguments are validated against that schema before any HTTP call is made.

## Safety notes

- This server can **create, update and delete real bookkeeping records**. Start with
  `--read-only` if you only need reporting, pin individual clients with
  `"mode": "read-only"`, and let your MCP client prompt for approval on write tools.
- **Credentials for several clients in one process** means one misrouted call touches
  someone else's books. The required `administration` argument, the enum of known
  aliases, the read-only restriction on fan-out, and the alias prefix on every error
  message (`[acme] HTTP 422: ...`) all exist for that reason. Keep the config file out of
  version control and readable only by you.
- Tools are annotated with `readOnlyHint`, `destructiveHint` and `idempotentHint`, so
  clients that use those hints can gate the risky ones.
- Nothing is logged to stdout, and credentials are never echoed in tool output or
  sent back to the setup page. `open_setup` returns a URL, never a key — an assistant has
  no way to read your credentials and no reason to ask you for them in a chat.
- The API description is downloaded without credentials, and a document that does not
  parse as a usable OpenAPI 3 file is rejected rather than adopted.

## License

MIT — see [LICENSE](LICENSE).
