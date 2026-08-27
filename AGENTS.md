# How to work here

I am the only developer, reviewer, and operator of this system. There is no team and no other
caller. Assume the direct version of the work and do not ask permission for it. If the direct
version has a real cost — data loss, a broken card in chat, an interrupted session — name it in a
sentence or two and proceed, rather than offering a menu of options.

- No transitional scaffolding, because leaving the old path looks like the considerate choice and is
  how two of everything got here: cut over in one move — rename, delete the old path in the same
  commit, update every call site, migrate or drop the data.
- Build for the case that exists. No extension points or config knobs with one implementation.
- A shared abstraction that needs a branch on which caller it serves is the wrong abstraction. Push
  the difference into an explicit capability or keep the implementations apart. Never add the branch.
- One concept, one name. Two names for the same thing is a defect.
- One path to production. A second mechanism doing the same job means one of them is wrong.
- Finish in one move: no TODO breadcrumbs, no stubs, no half-migrated state. If it cannot be
  finished, say so instead of leaving a seam.
- No team ceremony: no RFCs, ADRs, deprecation notices, changelog, or pull requests.
- Tests where they earn their keep: silent breakage, wiring that drifts, bugs actually found.
- Verify, don't reason. Run it, measure it, then state it — especially about CI, Docker, production.
- Docs only when they change what I do next.

# Delivery invariants

Getting these wrong publishes to a live audience twice, and no reviewer or type checks them.

- A write made under a condition checked earlier carries that condition in its `WHERE` — the lease,
  the status, the external id. A check standing apart from the write it guards is a defect.
- Anything that reached an audience is idempotent on retry or is settled as ambiguous. A second post
  is worse than an unclear status.
- Taking a publication down, putting it back, and journalling either is one transaction.
- A migration is rehearsed on a fresh copy of the production database before it is pushed: the
  squashed baseline is generated from the ORM schema and cannot show what production's own
  schema and data carry.
- Dates are text here and every query compares them as text, so a value that is not a date does not
  fail — it sorts, and the row disappears from a window while every report still lists it. A `_at`
  column holds a full ISO instant, a `_on` column a calendar day, both produced by `toISOString()`
  and never by SQLite's `CURRENT_TIMESTAMP` or a host-local `new Date(text)`. Anything arriving from
  outside is checked against that shape before it is stored, not merely handed to `Date`, which reads
  `"34Z"` as the year 2034. `ops audit` reports what slipped through as `storedDates`.

# Language

English-only: code, comments, identifiers, commit messages, test names, log and error messages,
docs. Russian belongs only to product content — UI strings, locale files, bot copy, post text. That
is data. Convert Russian comments in lines already being edited; do not open files to translate them.

# Workflow

Work on `main`. Typecheck, tests, and a production build before every push. CI/CD deploys the
primary production revision from `main`; secondary container revisions are deployed by hand and must
not be deployed unless asked.

# Persistence boundaries

`BackendDb` is the application handle; raw SQLite only through the explicitly named `unsafeDb(...)`.
Studio and Content go through persistence ports and their exception set in the architecture tests
stays empty. Publishing, Delivery and Channels own their transactions directly — that is the shape,
not a stage. Analytics, Operations, Observability and Engagement reach Drizzle directly, reads and writes both,
for the tables they own. Writing another area's table from there is not covered by that: delivery
state belongs to Delivery.

# Production

`bun run ops:prod [--as alex|maru] <command>` is the only production route, and every run prints
what it resolved to. A request that names Maru means `--as maru` throughout, including the follow-up
commands; one that names neither means alex. Both Studios publish text and video and collect
analytics; what differs is the public site (alex only) and the video platforms each one publishes to.

Start any worker, queue, configuration, publication or error investigation with
`ops guide --json`; it is read-only and it is the source of truth for routing, the command catalog
and what to run when the local database is unusable. Get CLI output before reading source for
production state, and never open the production database by hand.

**Never run a mutation without an explicit request** — `backup`, `restore`, `--apply` variants,
`format-record`, channel connect/disable, `retry`, manual SQL, deployments.

Handed an X Analytics CSV, import it without asking: `import-x-analytics`, then `x-analytics`.

# Operations registry

Every operation is one entry in `apps/backend/src/operations/registry.ts`: summary, zod schema,
`mutates`, `agent`, handler, optional formatter. The CLI dispatch, the `--help` and `guide`
catalogs, and the `ops_*` MCP tools are projections of it — adding an entry is the whole change, and
a usage string is never written by hand. Whatever an operator needs to know about one command
belongs in its `summary` or `note`, which reach all three surfaces; it does not belong here.
`agent: false` keeps an operation off MCP: that is the line for anything moving the database file,
writing credentials, or reading a host path.

# Local data

`bun scripts/dev-seed.ts` prints its own launch line and URLs. An empty database is normal, not a
bug — never write INSERTs by hand; change fixture shape in `apps/web/src/server/site-fixture.ts` or
`dashboard-fixture.ts`. The dashboard fixture is deliberately not all-green, and audience counts
read `—` locally because they come from live platform APIs.

happy-dom does not compute layout: `offsetTop`, `clientHeight` and `scrollTop` are always 0 there,
so player geometry and scrolling can only be verified in a real browser.
