# Who this file is for

This is the maintainer's working agreement for developing this repository. It is not a description
of the product, and every routing rule below names hosts and containers that exist only on the
maintainer's machines.

**Installing or operating your own Studio? Stop here and read [docs/install.md](docs/install.md).**
One command brings an instance up, and `docker compose exec app bun /app/ops/cli.js <command>` is
your operations route — `ops:prod` and `--as alex|maru` below are SSH into the maintainer's own
host and will never work for you. Nothing in this repository needs patching to install: identity,
domain, channels and credentials are all runtime configuration.

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
- A date column's shape is enforced by the database, so the trigger will say what it wants. What it
  cannot see is a well-shaped instant that is the wrong moment: `new Date("Thu, Aug 20, 2026")`
  resolves in the host's timezone, and the same import ran on two machines put one post on two days.
  Read the parts and build the instant in UTC.

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
what it resolved to. `alex` and `maru` are the names of the two containers on my host, not roles the
software knows about: this command is `ssh` plus `docker exec` and it exists nowhere else. A request that names Maru means `--as maru` throughout, including the follow-up
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

Every operation is one entry in `apps/backend/src/operations/registry.ts`: `section`, summary, zod
schema, `mutates`, `agent`, handler, optional formatter, optional `startHere`. The CLI dispatch, the
`--help` and `guide` catalogs, and the `ops_*` MCP tools are projections of it — adding an entry is
the whole change, and a usage string is never written by hand. Whatever an operator needs to know
about one command belongs in its `summary` or `note`, which reach all three surfaces; it does not
belong here.

`section` is which part of the catalog a command is read in, and it is required: `guide` answers
with section names and a symptom index, and expands one section on request, because the whole
catalog is 29KB and a caller reading it to answer one question pays for all of it. `startHere` is
the question a command is the beginning of the answer to; the symptom index is built from those, and
it is what a caller reads before it knows any section name.

`agent: false` keeps an operation off MCP. Every agent tool is listed in full in every context the
server is connected to, before anything is asked, so the line is: a read is on, because diagnosis is
what the agent surface is for; a mutation is on only if it is part of routine delivery work.
Anything that moves the database file, writes credentials or reads a host path is off regardless.

# Local data

`bun scripts/dev-seed.ts` prints its own launch line and URLs. An empty database is normal, not a
bug — never write INSERTs by hand; change fixture shape in `apps/web/src/server/site-fixture.ts` or
`dashboard-fixture.ts`. The dashboard fixture is deliberately not all-green, and audience counts
read `—` locally because they come from live platform APIs.

happy-dom does not compute layout: `offsetTop`, `clientHeight` and `scrollTop` are always 0 there,
so player geometry and scrolling can only be verified in a real browser.
