#!/bin/sh
# Solo Publisher installer.
#
#   curl -fsSL https://raw.githubusercontent.com/alexgetmancom/solo-publisher/main/install.sh | sh -s -- publisher.example.com
#
# Does what the README's Install section describes, in one command: checks
# Docker and that the domain resolves to this machine, writes .env with
# generated secrets, starts the stack, waits for /readyz through Caddy, and
# prints the Command Center URL. Re-running it keeps the existing .env and
# updates the stack.
set -eu

REPO_RAW="https://raw.githubusercontent.com/alexgetmancom/solo-publisher/main"
DIR="solo-publisher"
DOMAIN=""
SKIP_DNS_CHECK=0
BEHIND_PROXY=0

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

usage() {
	cat <<'USAGE'
Usage: install.sh <domain> [--dir <path>] [--skip-dns-check] [--behind-proxy]

  <domain>          hostname this Studio answers on; must already resolve here
  --dir <path>      install directory (default: ./solo-publisher)
  --skip-dns-check  install before DNS points here (TLS fails until it does)
  --behind-proxy    ports 80/443 already belong to another web server: start the
                    application alone on 127.0.0.1:8788 and print the one server
                    block to add. Implies --skip-dns-check, and that proxy owns
                    the certificate.
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
		-h|--help) usage; exit 0 ;;
		--dir) [ $# -ge 2 ] || die "--dir needs a path"; DIR="$2"; shift 2 ;;
		--skip-dns-check) SKIP_DNS_CHECK=1; shift ;;
		--behind-proxy) BEHIND_PROXY=1; SKIP_DNS_CHECK=1; shift ;;
		-*) usage >&2; die "unknown option: $1" ;;
		*) [ -z "$DOMAIN" ] || die "one domain, got '$DOMAIN' and '$1'"; DOMAIN="$1"; shift ;;
	esac
done

[ -n "$DOMAIN" ] || { usage >&2; die "no domain given"; }
case "$DOMAIN" in
	*[!a-zA-Z0-9.-]*|.*|*.|*..*|*[!a-zA-Z0-9]) die "'$DOMAIN' is not a hostname" ;;
	*.*) : ;;
	*) die "'$DOMAIN' has no dot; a certificate needs a real domain" ;;
esac

# --- prerequisites ------------------------------------------------------
step "Checking prerequisites"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v docker >/dev/null 2>&1 || die "Docker is not installed: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable (start it, or add this user to the docker group)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing; 'docker compose version' must work"
say "Docker and Compose are ready."

# --- DNS ----------------------------------------------------------------
resolve_domain() {
	if command -v getent >/dev/null 2>&1; then
		getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u && return 0
	fi
	if command -v dig >/dev/null 2>&1; then
		dig +short A "$1" 2>/dev/null | grep -E '^[0-9.]+$' && return 0
	fi
	if command -v host >/dev/null 2>&1; then
		host -t A "$1" 2>/dev/null | awk '/has address/ {print $NF}' && return 0
	fi
	return 1
}

if [ "$SKIP_DNS_CHECK" -eq 1 ]; then
	step "Skipping the DNS check"
else
	step "Checking that $DOMAIN points at this machine"
	public_ip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
	resolved="$(resolve_domain "$DOMAIN" || true)"
	[ -n "$resolved" ] || die "$DOMAIN does not resolve. Point an A record at this machine, or pass --skip-dns-check."
	if [ -z "$public_ip" ]; then
		say "Could not determine this machine's public address; $DOMAIN resolves to: $(echo "$resolved" | tr '\n' ' ')"
	elif echo "$resolved" | grep -qx "$public_ip"; then
		say "$DOMAIN resolves to $public_ip. Good."
	else
		die "$DOMAIN resolves to $(echo "$resolved" | tr '\n' ' ')but this machine is $public_ip.
Fix the A record (certificate issuance fails otherwise), or pass --skip-dns-check."
	fi
fi

# --- files --------------------------------------------------------------
step "Installing into $DIR"
mkdir -p "$DIR"
cd "$DIR"
files="compose.yaml Caddyfile"
[ "$BEHIND_PROXY" -eq 1 ] && files="compose.yaml"
for f in $files; do
	curl -fsSL "$REPO_RAW/$f" -o "$f.tmp" || die "could not download $f from $REPO_RAW"
	mv "$f.tmp" "$f"
done
say "$(echo "$files" | tr ' ' ',' | sed 's/,/ and /') $([ "$BEHIND_PROXY" -eq 1 ] && echo is || echo are) current."

# --- .env ---------------------------------------------------------------
secret() {
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex 32
	else
		od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; echo
	fi
}

if [ -f .env ]; then
	step "Keeping the existing .env"
	COMMAND_CENTER_TOKEN="$(sed -n 's/^COMMAND_CENTER_TOKEN=//p' .env | head -n 1)"
	MCP_STUDIO_TOKEN="$(sed -n 's/^MCP_STUDIO_TOKEN=//p' .env | head -n 1)"
	current_domain="$(sed -n 's/^DOMAIN=//p' .env | head -n 1)"
	[ "$current_domain" = "$DOMAIN" ] || say "note: .env keeps DOMAIN=$current_domain; edit it by hand to move this Studio to $DOMAIN."
	[ -n "$COMMAND_CENTER_TOKEN" ] || die ".env has no COMMAND_CENTER_TOKEN. Fill it with: openssl rand -hex 32"
else
	step "Writing .env with generated secrets"
	curl -fsSL "$REPO_RAW/.env.example" -o .env.example || die "could not download .env.example"
	COMMAND_CENTER_TOKEN="$(secret)"
	CLIENT_IP_HASH_SALT="$(secret)"
	TOKEN_ENCRYPTION_KEY="$(secret)"
	# The agent interface is part of the install, not a later step: without it a
	# fresh Studio has no way to be operated except a Telegram bot the installer
	# cannot create. Actor 1 is this installation's own operator -- the id labels
	# what the agent authors here and means nothing outside this database.
	MCP_STUDIO_TOKEN="$(secret)"
	DOMAIN="$DOMAIN" CC="$COMMAND_CENTER_TOKEN" SALT="$CLIENT_IP_HASH_SALT" TEK="$TOKEN_ENCRYPTION_KEY" MCP="$MCP_STUDIO_TOKEN" \
		awk '
			/^DOMAIN=/            { print "DOMAIN=" ENVIRON["DOMAIN"]; next }
			/^COMMAND_CENTER_TOKEN=/ { print "COMMAND_CENTER_TOKEN=" ENVIRON["CC"]; next }
			/^CLIENT_IP_HASH_SALT=/  { print "CLIENT_IP_HASH_SALT=" ENVIRON["SALT"]; next }
			/^TOKEN_ENCRYPTION_KEY=/ { print "TOKEN_ENCRYPTION_KEY=" ENVIRON["TEK"]; next }
			/^MCP_STUDIO_TOKEN=/     { print "MCP_STUDIO_TOKEN=" ENVIRON["MCP"]; next }
			/^MCP_STUDIO_ACTOR_ID=/  { print "MCP_STUDIO_ACTOR_ID=1"; next }
			{ print }
		' .env.example > .env.tmp
	mv .env.tmp .env
	chmod 600 .env
	rm -f .env.example
	say "Four secrets generated, the agent interface among them. Everything else in .env is optional."
fi

# --- start --------------------------------------------------------------
step "Starting the stack"
docker compose pull --quiet || true
if [ "$BEHIND_PROXY" -eq 1 ]; then
	docker compose up -d --no-deps app
	READY_URL="http://127.0.0.1:8788/readyz"
else
	docker compose up -d
	READY_URL="https://$DOMAIN/readyz"
fi

step "Waiting for $READY_URL"
ready=0
i=0
while [ "$i" -lt 60 ]; do
	if curl -fsS --max-time 5 "$READY_URL" >/dev/null 2>&1; then ready=1; break; fi
	i=$((i + 1))
	sleep 5
done

# What the operator does next, in the order it has to happen. Printed by both
# outcomes: an install that is up but not yet reachable still needs it.
next_steps() {
	cat <<NEXT

  Command Center: https://$DOMAIN/command-center?token=$COMMAND_CENTER_TOKEN

Operate it from an agent (Claude Code, Codex) over MCP:

  Endpoint: https://$DOMAIN/api/mcp
  Token:    $MCP_STUDIO_TOKEN

  claude plugin marketplace add alexgetmancom/solo-publisher
  claude plugin install studio@solo-publisher --scope user \\
    --config studio_url=https://$DOMAIN/api/mcp --config studio_token=<the token above>

Then connect what you publish to, and see what each destination still needs:

  docker compose exec app bun /app/ops/cli.js doctor
  docker compose exec app bun /app/ops/cli.js connect-link --platform x

Both tokens are in $PWD/.env; treat that file as a credential.
The public website is off. Turn it on with:

  docker compose exec app bun /app/ops/cli.js studio-profile-set --site-enabled

NEXT
}

if [ "$ready" -eq 1 ]; then
	say ""
	say "Solo Publisher is up."
	if [ "$BEHIND_PROXY" -eq 1 ]; then
		cat <<PROXY

It is listening on 127.0.0.1:8788 and nothing else. Your web server terminates
TLS for $DOMAIN and forwards to it; this is the whole server block:

  location / {
      proxy_pass http://127.0.0.1:8788;
      proxy_set_header Host \$host;
      proxy_set_header X-Real-IP \$remote_addr;
      # The MCP transport holds an event stream open, and a video upload must
      # not be buffered in the proxy first.
      proxy_buffering off;
      proxy_request_buffering off;
      proxy_read_timeout 3600s;
  }

PROXY
	fi
	next_steps
else
	cat <<BANNER

The containers are running, but $READY_URL did not answer within five minutes.
BANNER
	if [ "$BEHIND_PROXY" -eq 1 ]; then
		say "The application itself did not come up. Read why -- a missing or malformed"
		say "line in .env is named in the first lines of:"
		say ""
		say "  cd $PWD && docker compose logs app --tail 50"
	else
		say "Usually that is TLS: Caddy needs ports 80 and 443 reachable from the internet"
		say "to get a certificate. Check with:"
		say ""
		say "  cd $PWD && docker compose logs caddy --tail 50"
		say "  cd $PWD && docker compose logs app --tail 50"
	fi
	next_steps
	exit 1
fi
