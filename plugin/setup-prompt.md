You are setting up the `studio` plugin so that I can operate my self-hosted publishing system
(github.com/alexgetmancom/solo-publisher) from this machine by talking to you. Work through this
end to end, verifying each step by running something rather than by assuming. Ask me only for what
you genuinely cannot determine yourself.

## What you are building

My deployment is a container that already runs. It exposes an MCP transport at `/api/mcp`,
authorized by a bearer token, plus `/api/studio/media` for file uploads. The plugin bundles that
transport together with a skill, so once it is installed you can write, publish, schedule, read
analytics and diagnose delivery for me. Your job is to make the deployment expose those two routes,
give it a credential, install the plugin here, and prove the connection works.

## Rules you must not break

- **Never print the token** — not in your replies, not in a comment, not in a file you leave
  behind. Read it into a shell variable and use it from there. If you ever have to show me part of
  one, show its length, not its characters.
- **Back up before you edit** any file on the server: copy it next to itself with a timestamp and
  mode 0600 first.
- **Never publish anything.** This setup ends at "the tools respond". Do not create, publish,
  retry, edit or delete a post to test it — that reaches a real audience. Read-only calls only.
- **Stop and ask me** if: the deployment already has a `MCP_STUDIO_TOKEN` set, the reverse proxy
  config is not where you expect, the container is unhealthy before you start, or any step needs a
  credential I have not given you.
- Recreating the container interrupts the site and bot for a few seconds. Tell me before you do it.

## Step 0 — if there is no deployment yet

If I do not have a Studio running at all, install one first and then continue from Step 4. Ask me
for the server (SSH alias, or "it runs on this machine") and the hostname it should answer on, then
run the installer there:

    curl -fsSL https://raw.githubusercontent.com/alexgetmancom/solo-publisher/main/install.sh | sh -s -- <domain>

Add `--behind-proxy` if ports 80 and 443 already belong to another web server; the installer then
starts the application on `127.0.0.1:8788` and prints the server block to add. If I have no domain,
a wildcard-DNS hostname works: `publisher.<the-server-ip-with-dashes>.sslip.io`.

The installer generates `MCP_STUDIO_TOKEN` and `MCP_STUDIO_ACTOR_ID` itself, so Steps 1 and 3 are
already done when it finishes — read the token from the `.env` it wrote rather than making a new
one. Do not print it.

## Step 1 — find out what I have

Ask me, in one message, only for what you cannot discover:

- How do you reach the server? (SSH host alias, or "it runs on this machine")
- The deployment's public domain.
- Where the runtime directory is, if it is not `/home/deploy/<name>/`. It holds `secrets.env`,
  `deploy-image.env` and the compose file.

Then confirm the container is running and healthy before changing anything.

## Step 2 — expose the two routes

Check both from outside:

    curl -s -o /dev/null -w "%{http_code}\n" https://<domain>/api/mcp
    curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "X-Filename: t.bin" --data-binary "x" https://<domain>/api/studio/media

`401` and `403` mean the routes reach the application and are correctly refusing an unauthenticated
caller — that is the goal state, nothing to do. `404` means the reverse proxy never routed them.

If you get `404`, find the server block for that domain and add both locations. `/api/mcp` needs
`proxy_buffering off` and a long `proxy_read_timeout`, because the transport holds an event stream
open; `/api/studio/media` needs `proxy_request_buffering off` so an uploaded video is not buffered
in the proxy. Both refuse unauthenticated requests on their own, so exposing them is safe. Test the
config before reloading, and reload rather than restart.

## Step 3 — give the deployment a credential

In the deployment's `secrets.env`, both of these must be set together — the application refuses to
start with only one:

    MCP_STUDIO_TOKEN=<32 random bytes as hex>
    MCP_STUDIO_ACTOR_ID=<the actor id, see below>

Generate the token on the server with `openssl rand -hex 32` and write it without it passing
through your reply. If `MCP_STUDIO_TOKEN` is already set, stop and ask me before touching it —
replacing it breaks whatever is already using it.

The actor id is who *owns* the work you create here, and the token authorizes it: it needs no
separate roster entry. Use my Telegram user id if I also author from the bot, so both interfaces
own the same work; otherwise any positive integer will do — `1` is what the installer picks.

## Step 4 — restart and verify the deployment side

Recreate the container so it reads the new secrets, wait for its healthcheck to report healthy, then
run the operations CLI:

    <however this deployment runs its ops CLI> doctor

`checks.studioTransportConfigured` must be `true`. If it is `false`, the two variables are not both
set or the container did not pick them up.

Then prove the transport answers, with the token read from the server and never printed:

    curl -s -X POST https://<domain>/api/mcp \
      -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
      --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

A healthy deployment returns a long list of tools. An `error` field means the token or the actor is
wrong.

## Step 5 — install the plugin on this machine

    claude plugin marketplace add alexgetmancom/solo-publisher
    claude plugin install studio@solo-publisher --scope user \
      --config studio_url=https://<domain>/api/mcp \
      --config studio_token="$TOKEN"

`--scope user` makes it available from every directory on this machine, not just this project.

One caveat to tell me about rather than decide for me: a value passed as `--config` is briefly
visible in the machine's process list. If I would rather it never appear there, install without
`--config studio_token` and I will enter the token myself through the interactive `/plugin`
configuration screen.

Then tell me to run `/reload-plugins`, or to restart the session, and to check `/mcp` — the
`studio` server should be listed and connected.

## Step 6 — prove it works, without publishing

Ask the connected Studio what it can do and what is queued, using read-only tools only:
`studio_capabilities`, `studio_queue`, `ops_guide`, `ops_recent`. Report what came back: which
modules the deployment has (text, video, site, analytics), how many posts it has published, and
whether anything is currently failing.

## Step 7 — report

Tell me, briefly:

- Which routes you had to add, and which were already there.
- Whether the credential was already set or you generated it, and where to read it from if I need
  it later (the path, not the value).
- What `doctor` reports now.
- What the Studio says it can do.
- Anything you found that looks wrong but was outside this task.

If any step failed, say which one and what the actual output was. Do not report success for a step
you could not verify.
