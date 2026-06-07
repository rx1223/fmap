# fmap

> Extract a **feature capability map** from a codebase — *what a system can do, where it lives, and how to reach it.*

`fmap` reads your backend (GraphQL, REST/OpenAPI, tRPC, or plain route handlers) and your frontend, then produces a small, verifiable map of your product's capabilities. It does not presuppose a project structure — the capability source is pluggable and auto-detected. It exists to serve two readers:

- **AI agents** — locate a feature fast (and follow an anchor into the code) instead of grepping the whole repo.
- **operators** — verify each capability by hand, one falsifiable line at a time.

It is **not** a knowledge base and **not** API documentation.

## The one principle that matters

> **The map stores WHERE, not HOW.** It records where a capability lives and how to reach it. It never records the implementation or the business rules.

"How many trial cards can a user buy?" is a *rule* — it lives in code (`if count >= N`) or config, and it changes constantly. The map refuses to answer it. Instead it points an agent to the right operation/anchor to **read the rule live**. That is why the map doesn't rot: implementation churns, but *where the feature lives* rarely moves.

If you ever catch the map storing a limit, a threshold, or an `if`-result — that's a bug. It belongs in code, reached via the anchor.

## Install

Requires Node ≥ 18. The npm package is **`@rrr1223/fmap`**; it installs a `fmap` binary.

```bash
npm install -g @rrr1223/fmap     # or run ad-hoc with: npx -y @rrr1223/fmap <command>
```

Or from source:

```bash
git clone https://github.com/rx1223/fmap.git
cd fmap && npm install && npm run build && npm link
```

Then, in any TS/JS project (GraphQL, REST/OpenAPI, tRPC, or route handlers):

```bash
fmap auth --claude   # configure the LLM (stored globally, never in your repo)
fmap init            # scaffold ./feature-map, auto-detect source(s) + frontend
fmap build           # extract a draft capability map (everything: status: pending)
fmap query 营业额     # locate a capability → anchor → how to reach it
fmap render          # generate human-readable md views
fmap check           # detect drift between the map and the code
```

## Commands

| Command | What it does |
|---|---|
| `fmap auth --claude` | Configure the LLM platform + key **globally** (XDG). Key is env-first; storing it is opt-in and `chmod 600`. |
| `fmap init [-y]` | Scaffold `./feature-map`, auto-detect capability source(s) + frontend (tier-1), ask the tier-2 knobs (each defaulted). |
| `fmap build [--dry-run]` | backend × frontend → capability YAML. `--dry-run` previews operations, call-sites, and quadrants with no LLM call. |
| `fmap check` | Read-only drift detection. Exits non-zero on drift (so CI *can* use it later). |
| `fmap render` | Generate `feature-map/generated/*.md` views from the YAML. |
| `fmap query [text]` | Fuzzy-locate capabilities by name/object; prints anchor + reach path. |
| `fmap query --serve` | Run a local **MCP server** (stdio) so agents can query the map as tools. |

There is intentionally **no `approve` command**. In the CLI phase, *approve = a human editing `status: pending → approved` in the YAML*, then commit + PR review.

## Agent integration

Built for AI agents (Claude Code, Cursor, …) working in the repo. `fmap init` makes a project agent-ready out of the box (opt out with `--no-skill`):

- **`.claude/skills/feature-map/SKILL.md`** — a skill that triggers on *"where is X / how do I reach Y / what can this app do"* and teaches the workflow: the map says **WHERE**, code says **HOW**; `find → open the code_anchor → read the real rule`.
- **`.mcp.json`** — registers the MCP server: `{ "mcpServers": { "fmap": { "command": "npx", "args": ["-y", "@rrr1223/fmap", "query", "--serve"] } } }`.

The server is **local** (stdio) — the agent spawns it with the repo as `cwd`. It serves only the small **map**, never your code; the agent opens the `code_anchor` in its own checkout. Read-only tools:

| Tool | Returns |
|---|---|
| `find_capability(text)` | matching capabilities + statement, operations, `code_anchor`, reach path |
| `get_anchor(id)` | the file#symbol to open and read the actual rule |
| `list_capabilities(status?)` | all capabilities (id, name, status, statement) |
| `how_to_reach(id)` | the UI navigation path(s) to a capability |

Agents only **read**: promotion to `approved` is always a human edit — no tool mutates the map.

*(How this scales: today fmap is a local per-repo tool. A future hosted/team server — GitHub App → server-side build → remote MCP — would reuse the exact same engine; it's on the roadmap, not built.)*

## How it works

### Three decoupled collections

1. **Capabilities** — a user-perceivable thing one can do (`查看店铺营业额`, `购买体验卡`). The unit is *the name a user would say when asking for help* — not a button, not a whole module. Each is a falsifiable statement (verb + object + location).
2. **Sitemap** — page nodes + tree (`parent`) + entity hubs + a few special transitions. A graph, kept in one file.
3. **Mounts** — which page(s) expose which capability (`mounted_on`). Many-to-many. A mount is **not** a transition edge.

Adding a capability touches capabilities + mounts, not the sitemap. A nav change touches the sitemap, not capabilities. Their rot is isolated.

Semantic links between capabilities (user → order → revenue) are **not stored** — they emerge at query time from the `object` tags. Page transitions **are** stored, because they're finite, load-bearing, and can't be derived.

### Capability sources (pluggable — no presupposed structure)

A **capability source** turns a project's backend surface into *operations*. The pipeline is source-agnostic; `fmap init` detects which source(s) a project uses and records them in the config. Built-in sources:

| Source | Operations from | Frontend usage matched from |
|---|---|---|
| **graphql** | introspection (SDL file or live endpoint) | `useQuery`/`useMutation`/… + `client.query/mutate`, named & inline `gql` |
| **openapi** | OpenAPI v3 / Swagger v2 spec (path × method) | `fetch`/`axios` URLs → path templates (base path tolerated) |
| **trpc** | router tree → dotted procedure paths | `trpc.a.b.useQuery()` client chains |
| **route** | Express/Fastify routes, Next.js `app/**/route.ts` + `pages/api` | `fetch`/`axios` URLs → route paths |

Adding a protocol = implement one `CapabilitySource` (`detect` / `loadOperations` / `scanUsage`) and register it. Everything downstream is unchanged. Multiple sources can be active in one project.

### Operations × frontend call-sites → four quadrants

The backend says what the system *theoretically* can do; the frontend says what users can *actually* reach. They overlap — they aren't the same set. So extraction is a cross-product, classified into four quadrants:

```
                  frontend HAS call      frontend NO call          scanner CAN'T TELL
backend HAS    →  user capability        no_entry                  UNKNOWN — hold, don't
                  + UI anchor + mount     (dead / ops-only / cron)  conclude. "didn't see it"
backend NO     →  (non-modelled path)     —                         —
                  side-effect cap → self-growth
```

**Frontend code is messy** (dynamic query names, interpolated templates, HOCs). Static scanning *can't* be complete — so `fmap` is honest about it. The scanner resolves only high-confidence call-sites and marks everything else **UNKNOWN** rather than forcing a wrong guess. Tidy codebases get a small UNKNOWN quadrant; messy ones get a large one — neither breaks, they just converge at different speeds.

One frontend call (`useQuery(STORE_REVENUE)`) gives three things at once: proof the capability is real, its **UI anchor** (which page), and the **mount**. Mounts are extracted, never hand-authored.

### The LLM does exactly one thing: re-slice operations into capabilities

A source returns an *operation list*, not a *capability list*. The model:

- **merges** several operations serving one goal (`todayRevenue + revenueByRange + revenueBreakdown` → "view store revenue"),
- **splits** one operation that bundles actions (`updateMembershipCard` → renew / upgrade / replace),
- writes a human name + a falsifiable statement, and drops residual noise.

Everything else — status, mounts, `object` tags — is computed deterministically from the classification, so the model can't invent provenance. A *called* operation the model drops is re-emitted, never lost.

### Agent proposes, human approves

Every machine-extracted entry is born `status: pending`. **No code path ever writes `approved`** — only a human does, by editing the YAML. This is non-negotiable: the gate isn't on *where the data came from*, it's on *the agent's classification* ("is this a capability?"), which a human who knows how the system is used must back. Without this, the map fills with unverified guesses and rots back into the knowledge base we're avoiding.

### Self-growth

The map is pulled along by real questions, not pre-scanned exhaustively. Solve the user's question first (fall back to a full code search), then backfill the *gap* as a `pending` candidate for a human to approve. The review queue doubles as a ranked list of "blind spots users hit most."

## File format — YAML is truth, md is a generated view

The whole `feature-map/` directory lives **inside your project's repo**, so map changes ride the same PR as the code.

```
feature-map/
  capabilities/            # one YAML file per business module (a list — splittable)
    membership-card.yaml
    store-finance.yaml
    user.yaml
  sitemap.yaml             # pages + transitions + hubs (a graph — one file)
  generated/               # md views from `fmap render` — DO NOT EDIT
  feature-map.config.yaml
```

A capability entry:

```yaml
- id: cap.purchase_trial_card
  name: 购买体验卡
  statement: 在收银台给用户购买体验卡            # falsifiable: verb + object + location
  object: [MembershipCard]                       # chaining backbone (from backend types)
  mounted_on: [page.cardpage]                    # structured, not a fragile md link
  operations: [purchaseTrialCard]                # underlying op ids (resolver / endpoint / procedure)
  status: pending                                # approved | pending | unknown | deprecated
  source: introspection                          # introspection | ops | user_question | code_pr
```

**Humans edit the YAML; never the generated md.** On the next `fmap build`, machine fields (`object`, `operations`, `mounted_on`, `code_anchor`) are refreshed from code while human fields (`name`, `statement`, `status`, manual mounts) are preserved. A capability gone from code is marked `deprecated`, never deleted.

## Configuration

Two separate places, on purpose — it's a security boundary:

- **Global (user-level)** — LLM platform + credentials, under `$XDG_CONFIG_HOME/fmap` (falling back to `~/.config/fmap`). Reused across projects. **API key precedence: `ANTHROPIC_API_KEY` env var first** (recommended); persisting to the config file is opt-in and `chmod 600`. The key is **never** written into a project repo.
- **Project-level (committed)** — `feature-map/feature-map.config.yaml`: the capability `sources` (each with a `type` + its own fields), the frontend root, and the tier-2 strategy knobs (all defaulted). For example:

  ```yaml
  sources:
    - type: graphql        # sdlPath: schema.graphql   OR   endpoint: https://…
    - type: openapi        # specPath: openapi.yaml
    - type: trpc           # routerPath: server/router.ts
    - type: route          # root: server
  frontend:
    root: src
  ```

### Three tiers of decisions

1. **Auto-detect (don't ask)** — which capability source(s) a project uses, tree-vs-cross-jump nav, entity hubs, the operation × call-site classification. You review/edit a draft rather than fill from scratch.
2. **Let you choose (ask, always with a default)** — ops-only capabilities included or not, capability granularity, special cross-jump edges. CLI flags / `init` prompts; unset → default.
3. **Hard-wired (never configurable)** — agent-proposes/human-approves, where-not-how, the three-layer model, UNKNOWN stays unknown.

## Status

v0 is the **CLI engine**. The human-interaction half (graphical approve, visual review) is the planned **app phase**; for now approve = edit YAML + git + PR review. CodeGraph-style symbol traversal is intentionally **out of scope** — `fmap` emits anchors; an agent can use a symbol graph independently to traverse from them. No CI/hooks are wired yet (`check` exists and exits non-zero on drift, so CI *can* adopt it later).

## Development

```bash
npm run build    # tsc → dist/
npm test         # node:test via tsx (classify, extract, reconcile, sitemap)
npm run fmap -- <cmd>   # run the CLI from source without building
```

## License

[MIT](LICENSE)
