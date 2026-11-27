#!/usr/bin/env bash
set -euo pipefail

ENV_AT_START=" $(compgen -e | tr '\n' ' ') "
FLAGS_GIVEN=' '

ORCHARD_VERSION=${ORCHARD_VERSION:-}
CHART_REF=${ORCHARD_CHART:-oci://ghcr.io/hackclub/orchard/charts/orchard}
IMAGE_REGISTRY=${ORCHARD_IMAGE_REGISTRY:-ghcr.io}
IMAGE_REPOSITORY=${ORCHARD_IMAGE_REPOSITORY:-hackclub/orchard}
STATE_DIR=${ORCHARD_STATE_DIR:-/etc/orchard}
VALUES_FILE="$STATE_DIR/values.yaml"
SYSCTL_CONF=${ORCHARD_SYSCTL_CONF:-/etc/sysctl.d/90-orchard-builds.conf}
REGISTRIES_FILE=${ORCHARD_REGISTRIES_FILE:-/etc/rancher/k3s/registries.yaml}
APPARMOR_DIR=${ORCHARD_APPARMOR_DIR:-/etc/apparmor.d}
APPARMOR_STACKING_PROC=${ORCHARD_APPARMOR_STACKING_PROC:-/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined}
IMAGE_GC_FILE=${ORCHARD_IMAGE_GC_FILE:-/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/05-orchard-image-gc.conf}

K3S_VERSION=${K3S_VERSION:-}
K3S_CHANNEL=${K3S_CHANNEL:-v1.36}
HELM_VERSION=${HELM_VERSION:-v4.3.1}
CNPG_CHART_VERSION=${CNPG_CHART_VERSION:-0.29.1}
BARMAN_PLUGIN_PINNED=0.9.0
BARMAN_PLUGIN_CHART_VERSION=${BARMAN_PLUGIN_CHART_VERSION:-$BARMAN_PLUGIN_PINNED}
BARMAN_PLUGIN=''
IN_TREE_BACKUPS=0
NODE_PORT_RANGE=${ORCHARD_NODE_PORT_RANGE:-30000-30100}
HTTP_PORT=${ORCHARD_HTTP_PORT:-80}
HTTPS_PORT=${ORCHARD_HTTPS_PORT:-443}
HTTP_SUFFIX=''
HTTPS_SUFFIX=''
INGRESS_EXTRA_HOSTS='[]'
REGISTRY_PORT=${ORCHARD_REGISTRY_PORT:-5000}
REGISTRY_USER=orchard
REGISTRY_PASSWORD=''
REGISTRY_HOST=${ORCHARD_REGISTRY_HOST:-registry.orchard.local}

ORCHARD_DOMAIN=${ORCHARD_DOMAIN:-}
ORCHARD_APP_DOMAIN=${ORCHARD_APP_DOMAIN:-}
ORCHARD_ACME_EMAIL=${ORCHARD_ACME_EMAIL:-}
ORCHARD_INGRESS_MODE=${ORCHARD_INGRESS_MODE:-}
ORCHARD_TUNNEL_TOKEN=${ORCHARD_TUNNEL_TOKEN:-}
ORCHARD_UPDATE_POLICY=${ORCHARD_UPDATE_POLICY:-}
ORCHARD_METRICS=${ORCHARD_METRICS:-true}
ORCHARD_LOGS=${ORCHARD_LOGS:-true}
ORCHARD_IMAGE_SCANNING=${ORCHARD_IMAGE_SCANNING:-true}
ORCHARD_OBJECT_STORAGE=${ORCHARD_OBJECT_STORAGE:-true}
ORCHARD_MCP=${ORCHARD_MCP:-true}
ORCHARD_LIMITS=${ORCHARD_LIMITS:-}
ORCHARD_MCP_DOMAIN=${ORCHARD_MCP_DOMAIN:-}
ORCHARD_S3=${ORCHARD_S3:-}
ORCHARD_S3_ENDPOINT=${ORCHARD_S3_ENDPOINT:-}
ORCHARD_S3_BUCKET=${ORCHARD_S3_BUCKET:-}
ORCHARD_S3_REGION=${ORCHARD_S3_REGION:-}
ORCHARD_S3_PATH_STYLE=${ORCHARD_S3_PATH_STYLE:-}
ORCHARD_S3_ACCESS_KEY=${ORCHARD_S3_ACCESS_KEY:-}
ORCHARD_S3_SECRET_KEY=${ORCHARD_S3_SECRET_KEY:-}
ORCHARD_S3_SECRET_KEY_FILE=${ORCHARD_S3_SECRET_KEY_FILE:-}
S3_READY=false
S3_PROBE_ERROR=''
ASSUME_YES=${ORCHARD_ASSUME_YES:-false}
ALLOW_IPV6_ONLY=${ORCHARD_ALLOW_IPV6_ONLY:-false}
INSTALL_URL=${ORCHARD_INSTALL_URL:-https://assets.orchard.my/install.sh}
PROMPT_TIMEOUT=${ORCHARD_PROMPT_TIMEOUT:-900}
PROMPT_FD_OPEN=false
PORTS_BUSY=''
PORTS_BUSY_DETAIL=''
PROMPT_BLOCKED=''
PROMPT_HINT_SHOWN=false
PREVIOUS_INSTALL=false
PREVIOUS_EXTRA_HOSTS=''
PUBLIC_IP=''
PUBLIC_IP6=''
PRIMARY_IP=''
LOCAL_IPS=''
LOCAL_IPS6=''
BEHIND_NAT=true
CLOUD=''
DMI_DIR=${ORCHARD_DMI_DIR:-/sys/class/dmi/id}
MEMINFO_FILE=${ORCHARD_MEMINFO_FILE:-/proc/meminfo}
TINY_BOX_MB=3500
ORCHARD_PUBLIC_IP=${ORCHARD_PUBLIC_IP:-}
ORCHARD_INGRESS_CNAME=${ORCHARD_INGRESS_CNAME:-}
INGRESS_MODE=''
DOMAIN_SET=false
APP_DOMAIN_SET=false
MCP_DOMAIN_SET=false
CNAME_SET=false
PUBLIC_IP_SET=false
MOVING_OFF_SSLIP=false
PREV_MODE=''
PREV_DOMAIN=''
PREV_APP_DOMAIN=''
PREV_MCP=''
PREV_MCP_DOMAIN=''
PREV_CNAME=''
PREV_PUBLIC_IP=''
PREV_EMAIL=''
PREV_UPDATES=''

HOST_DEFAULTS_VERSION=5

IMAGE_TAG=${ORCHARD_IMAGE_TAG:-}
IMAGE_PULL_POLICY=${ORCHARD_IMAGE_PULL_POLICY:-}

START_TS=$(date +%s)
IS_TTY=false
if [ -t 1 ]; then IS_TTY=true; fi

if [ "$IS_TTY" = true ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  case "${COLORTERM:-}" in
    truecolor|24bit)
      C_BRAND=$'\033[38;2;174;42;58m'
      C_BRIGHT=$'\033[38;2;214;77;94m'
      ;;
    *)
      C_BRAND=$'\033[38;5;125m'
      C_BRIGHT=$'\033[38;5;167m'
      ;;
  esac
  C_OK=$'\033[38;5;108m'; C_AMBER=$'\033[38;5;179m'
  C_FAIL=$'\033[38;5;203m'; C_GREY=$'\033[38;5;245m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''
  C_BRAND=''; C_BRIGHT=''; C_OK=''; C_AMBER=''; C_FAIL=''; C_GREY=''
fi

pace() {
  if [ "$IS_TTY" = true ] && [ "${ORCHARD_NO_PACING:-}" != "1" ]; then sleep "$1"; fi
}

WIDTH=68
SPINNER=('...' '.. ' '.  ' ' . ' '  .' ' ..')
if [ "$IS_TTY" = true ]; then
  SPINNER=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
fi

PLAN_TITLES=(
  "Check this machine"
  "Check the network"
  "Your answers"
  "DNS records"
  "Install k3s"
  "Install Helm"
  "Install platform operators"
  "Install the container registry"
  "Install the Cloudflare tunnel"
  "Write the configuration"
  "Install Orchard"
  "Install the updater"
  "Finish"
)
PLAN_COSTS=(6 6 0 0 40 5 60 45 15 1 180 1 0)

STEP_N=0
STEP_TOTAL=${#PLAN_TITLES[@]}
REMAINING=0

fmt_secs() {
  if [ "$1" -ge 60 ]; then printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); else printf '%ds' "$1"; fi
}

elapsed() { fmt_secs $(($(date +%s) - START_TS)); }

rule() {
  local n=$1 out=''
  while [ "$n" -gt 0 ]; do out="${out}─"; n=$((n - 1)); done
  printf '%s' "$out"
}

pad_line() {
  local text=$1 plain
  plain=$(printf '%s' "$text" | sed 's/\x1b\[[0-9;]*m//g')
  printf '%s%s│%s %s%*s %s│%s\n' \
    '  ' "$C_BRAND" "$C_RESET" "$text" $((WIDTH - ${#plain} - 2)) '' "$C_BRAND" "$C_RESET"
}

box_top() { printf '%s%s╭%s╮%s\n' '  ' "$C_BRAND" "$(rule $WIDTH)" "$C_RESET"; }
box_bottom() { printf '%s%s╰%s╯%s\n' '  ' "$C_BRAND" "$(rule $WIDTH)" "$C_RESET"; }

banner() {
  printf '\n'
  pace 0.15
  box_top
  pad_line ""
  pace 0.2
  pad_line "$C_BRIGHT$C_BOLD  ORCHARD$C_RESET$C_DIM   self-hosted app platform$C_RESET"
  pad_line ""
  pace 0.35
  pad_line "$C_DIM  One box, one command. A few minutes on a clean machine.$C_RESET"
  pad_line ""
  box_bottom
  printf '\n'
  pace 0.5
}

show_plan() {
  printf '  %sWhat happens next%s\n' "$C_BOLD" "$C_RESET"
  pace 0.25
  local i=0
  while [ "$i" -lt "$STEP_TOTAL" ]; do
    printf '  %s%2d  %s%s\n' "$C_GREY" $((i + 1)) "${PLAN_TITLES[$i]}" "$C_RESET"
    pace 0.05
    i=$((i + 1))
  done
  printf '\n'
  pace 0.6
}

info() { printf '      %s%s%s\n' "$C_GREY" "$*" "$C_RESET"; }
note() { printf '      %s\n' "$*"; }
bold() { printf '  %s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
warn() { printf '   %s!%s  %s%s%s\n' "$C_AMBER" "$C_RESET" "$C_AMBER" "$*" "$C_RESET" >&2; }
# $$ stays the top-level pid inside a subshell, BASHPID does not: a die() from
# inside a command substitution (ask, mostly) has to take the whole install with
# it rather than just returning an empty answer to the caller.
die() {
  printf '\n   %sx  %s%s\n\n' "$C_FAIL" "$*" "$C_RESET" >&2
  if [ "${BASHPID:-$$}" != "$$" ]; then kill -s TERM "$$" 2>/dev/null || true; fi
  exit 1
}
trap 'exit 1' TERM

step() {
  local title left='' head
  title=${PLAN_TITLES[$STEP_N]}
  local cost=${PLAN_COSTS[$STEP_N]}
  STEP_N=$((STEP_N + 1))

  if [ "$REMAINING" -gt 45 ]; then left=" ${C_DIM}·${C_RESET} ${C_GREY}~$(fmt_secs "$REMAINING") left${C_RESET}"; fi
  head="  ${C_BRAND}${C_BOLD}${STEP_N}/${STEP_TOTAL}${C_RESET}  ${C_BOLD}${title}${C_RESET}"

  printf '\n%s\n' "$head"
  printf '  %s%s%s  %s%s elapsed%s%s\n' \
    "$C_BRAND" "$(rule 4)" "$C_RESET" "$C_GREY" "$(elapsed)" "$C_RESET" "$left"

  REMAINING=$((REMAINING - cost))
  if [ "$REMAINING" -lt 0 ]; then REMAINING=0; fi
}

run_step() {
  local label=$1 typical=$2
  shift 2
  local log t0 pid rc=0 i=0 beat=0 secs frame

  log=$(mktemp)
  t0=$(date +%s)

  "$@" >"$log" 2>&1 &
  pid=$!

  while kill -0 "$pid" 2>/dev/null; do
    secs=$(($(date +%s) - t0))
    if [ "$IS_TTY" = true ]; then
      frame=${SPINNER[$((i % ${#SPINNER[@]}))]}
      printf '\r      %s%s%s %s %s%s / ~%s%s\033[K' \
        "$C_BRIGHT" "$frame" "$C_RESET" "$label" "$C_GREY" "$(fmt_secs "$secs")" "$typical" "$C_RESET"
      i=$((i + 1))
    elif [ "$secs" -ge $((beat + 30)) ]; then
      beat=$secs
      printf '      .. %s  %s elapsed (typically %s)\n' "$label" "$(fmt_secs "$secs")" "$typical"
    fi
    sleep 0.1
  done

  wait "$pid" || rc=$?
  secs=$(($(date +%s) - t0))

  if [ "$rc" -ne 0 ]; then
    if [ "$IS_TTY" = true ]; then printf '\r\033[K'; fi
    printf '      %sx%s %s %sfailed after %s%s\n\n' \
      "$C_FAIL" "$C_RESET" "$label" "$C_FAIL" "$(fmt_secs "$secs")" "$C_RESET" >&2
    sed 's/^/        /' "$log" | tail -25 >&2
    printf '\n' >&2
    rm -f "$log"
    exit 1
  fi

  if [ "$IS_TTY" = true ]; then
    printf '\r      %s✓%s %s %s%s%s\033[K\n' \
      "$C_OK" "$C_RESET" "$label" "$C_GREY" "$(fmt_secs "$secs")" "$C_RESET"
  else
    printf '      ok %s (%s)\n' "$label" "$(fmt_secs "$secs")"
  fi
  rm -f "$log"
}

usage() {
  cat <<'EOF'

  Orchard installer

  Usage:
    install.sh [flags]

  Every flag has an environment variable equivalent. Flags win.

  How traffic gets in
    --mode <public|tunnel|lan>   ORCHARD_INGRESS_MODE   how the internet reaches this box
    --public-ip <ip|none>        ORCHARD_PUBLIC_IP      address for raw ports and public databases
                                                        (default: detected. In tunnel mode: none)
    --domain <host>              ORCHARD_DOMAIN         the dashboard (public mode default: an
                                                        sslip.io name. lan default: this address)
    --app-domain <host>          ORCHARD_APP_DOMAIN     parent of app URLs, needs a wildcard record
                                                        (default: apps.<parent of your domain>)
    --ingress-cname <host|none>  ORCHARD_INGRESS_CNAME  what custom domains CNAME to (default: the
                                                        dashboard. In tunnel mode: the tunnel)
    --mcp-domain <host>          ORCHARD_MCP_DOMAIN     where agents connect over MCP
                                                        (default: mcp.<parent of your domain>)
    --email <address|none>       ORCHARD_ACME_EMAIL     Let's Encrypt contact, optional
    --tunnel-token <token>       ORCHARD_TUNNEL_TOKEN   Cloudflare Tunnel token, tunnel mode
    --http-port <port>           ORCHARD_HTTP_PORT      where Traefik listens, lan mode only
                                                        (default: 80)
    --https-port <port>          ORCHARD_HTTPS_PORT     the same for TLS (default: 443)

  Behaviour
    --updates <manual|automatic> ORCHARD_UPDATE_POLICY  update yourself, or nightly
                                                        (default: manual)
    --metrics <true|false>       ORCHARD_METRICS        built-in metrics stack (default: on,
                                                        trimmed below 8G RAM)
    --logs <true|false>          ORCHARD_LOGS           searchable log store (default: on)
    --image-scanning <true|false>
                                 ORCHARD_IMAGE_SCANNING vulnerability scans of built images
                                                        (default: on)
    --object-storage <true|false>
                                 ORCHARD_OBJECT_STORAGE local S3 store for database backups
                                                        (default: on; same disk, not DR)
    --mcp <true|false>           ORCHARD_MCP            the MCP endpoint agents connect to
                                                        (default: on)

  S3-compatible storage, optional. Backups stay on this box without it.
    --s3-endpoint <url>          ORCHARD_S3_ENDPOINT    for example https://s3.eu-west-1.amazonaws.com
    --s3-bucket <name>           ORCHARD_S3_BUCKET      holds backups, uploads and build contexts
    --s3-region <name>           ORCHARD_S3_REGION      default: auto
    --s3-path-style              ORCHARD_S3_PATH_STYLE  <endpoint>/<bucket> (default). Set the
    --no-s3-path-style                                  variable to false for <bucket>.<endpoint>
    --s3-access-key <id>         ORCHARD_S3_ACCESS_KEY
    --s3-secret-key-file <path>  ORCHARD_S3_SECRET_KEY_FILE
                                 ORCHARD_S3_SECRET_KEY  the secret key. Prefer one of these
    --s3-secret-key <secret>                            stays in your shell history
    --no-s3                      ORCHARD_S3=false       skip the question

    --limits <on|off>            ORCHARD_LIMITS         resource limits on apps and databases.
                                                        Unset, the setup page asks. Either way,
                                                        you can change it later in the dashboard
    --yes, -y                    ORCHARD_ASSUME_YES     never prompt and never wait for DNS: use
                                                        flags, then current values, then defaults.
                                                        A required answer with no default stops
                                                        the run and names its flag
                                 ORCHARD_PROMPT_TIMEOUT seconds to wait on a question before
                                                        giving up (default: 900, 0 waits forever)
    --allow-ipv6-only            ORCHARD_ALLOW_IPV6_ONLY=true
                                                        continue on a server with no IPv4 address.
                                                        IPv6-only servers are not supported yet, so
                                                        this is untested. --yes doesn't imply it
    --help, -h                                         show this and exit

  Versions and images
    --chart <ref>                ORCHARD_CHART          helm chart, OCI ref or local path
    --chart-version <semver>     ORCHARD_VERSION        pin the chart version and its images
    --image-tag <tag>            ORCHARD_IMAGE_TAG      tag for server and frontend, such as latest.
                                                        Unset, they run the chart's release versions
    --image-pull-policy <policy> ORCHARD_IMAGE_PULL_POLICY
                                                        Unset, Always for latest and IfNotPresent otherwise
    --image-registry <host>      ORCHARD_IMAGE_REGISTRY
    --image-repository <path>    ORCHARD_IMAGE_REPOSITORY

  Cluster
    --k3s-channel <channel>      K3S_CHANNEL            k3s release channel (default: v1.36)
    --k3s-version <version>      K3S_VERSION            pin k3s, and turn off its automatic patches
                                 HELM_VERSION           helm release to install (default: v4.3.1)
    --node-port-range <lo-hi>    ORCHARD_NODE_PORT_RANGE  ports apps can claim
    --registry-port <port>       ORCHARD_REGISTRY_PORT    loopback port the kubelet pulls through
    --registry-host <host>       ORCHARD_REGISTRY_HOST    name the kubelet pulls by
    --state-dir <path>           ORCHARD_STATE_DIR        where values.yaml is written

  Also honoured: NO_COLOR disables all colour, ORCHARD_NO_PACING=1 removes the
  brief pauses in the opening screen.

  Fully non-interactive example:

    ORCHARD_ASSUME_YES=true install.sh \
      --mode public \
      --domain orchard.example.com

EOF
}

need_value() {
  if [ -z "${2:-}" ]; then die "$1 needs a value"; fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    FLAGS_GIVEN="$FLAGS_GIVEN$1 "
    case "$1" in
      --mode) need_value "$1" "${2:-}"; ORCHARD_INGRESS_MODE=$2; shift 2 ;;
      --public-ip) need_value "$1" "${2:-}"; ORCHARD_PUBLIC_IP=$2; shift 2 ;;
      --domain) need_value "$1" "${2:-}"; ORCHARD_DOMAIN=$2; shift 2 ;;
      --app-domain) need_value "$1" "${2:-}"; ORCHARD_APP_DOMAIN=$2; shift 2 ;;
      --ingress-cname) need_value "$1" "${2:-}"; ORCHARD_INGRESS_CNAME=$2; shift 2 ;;
      --mcp-domain) need_value "$1" "${2:-}"; ORCHARD_MCP_DOMAIN=$2; shift 2 ;;
      --mcp) need_value "$1" "${2:-}"; ORCHARD_MCP=$2; shift 2 ;;
      --limits) need_value "$1" "${2:-}"; ORCHARD_LIMITS=$2; shift 2 ;;
      --s3-endpoint) need_value "$1" "${2:-}"; ORCHARD_S3_ENDPOINT=$2; shift 2 ;;
      --s3-bucket) need_value "$1" "${2:-}"; ORCHARD_S3_BUCKET=$2; shift 2 ;;
      --s3-region) need_value "$1" "${2:-}"; ORCHARD_S3_REGION=$2; shift 2 ;;
      --s3-access-key) need_value "$1" "${2:-}"; ORCHARD_S3_ACCESS_KEY=$2; shift 2 ;;
      --s3-secret-key) need_value "$1" "${2:-}"; ORCHARD_S3_SECRET_KEY=$2; warn "a secret on the command line stays in your shell history; prefer --s3-secret-key-file or ORCHARD_S3_SECRET_KEY"; shift 2 ;;
      --s3-secret-key-file) need_value "$1" "${2:-}"; ORCHARD_S3_SECRET_KEY_FILE=$2; shift 2 ;;
      --s3-path-style) ORCHARD_S3_PATH_STYLE=true; shift ;;
      --no-s3-path-style) ORCHARD_S3_PATH_STYLE=false; shift ;;
      --no-s3) ORCHARD_S3=false; shift ;;
      --email) need_value "$1" "${2:-}"; ORCHARD_ACME_EMAIL=$2; shift 2 ;;
      --tunnel-token) need_value "$1" "${2:-}"; ORCHARD_TUNNEL_TOKEN=$2; shift 2 ;;
      --updates) need_value "$1" "${2:-}"; ORCHARD_UPDATE_POLICY=$2; shift 2 ;;
      --metrics) need_value "$1" "${2:-}"; ORCHARD_METRICS=$2; shift 2 ;;
      --logs) need_value "$1" "${2:-}"; ORCHARD_LOGS=$2; shift 2 ;;
      --image-scanning) need_value "$1" "${2:-}"; ORCHARD_IMAGE_SCANNING=$2; shift 2 ;;
      --object-storage) need_value "$1" "${2:-}"; ORCHARD_OBJECT_STORAGE=$2; shift 2 ;;
      --chart) need_value "$1" "${2:-}"; CHART_REF=$2; shift 2 ;;
      --chart-version) need_value "$1" "${2:-}"; ORCHARD_VERSION=$2; shift 2 ;;
      --image-tag) need_value "$1" "${2:-}"; IMAGE_TAG=$2; shift 2 ;;
      --image-pull-policy) need_value "$1" "${2:-}"; IMAGE_PULL_POLICY=$2; shift 2 ;;
      --image-registry) need_value "$1" "${2:-}"; IMAGE_REGISTRY=$2; shift 2 ;;
      --image-repository) need_value "$1" "${2:-}"; IMAGE_REPOSITORY=$2; shift 2 ;;
      --k3s-channel) need_value "$1" "${2:-}"; K3S_CHANNEL=$2; shift 2 ;;
      --k3s-version) need_value "$1" "${2:-}"; K3S_VERSION=$2; shift 2 ;;
      --node-port-range) need_value "$1" "${2:-}"; NODE_PORT_RANGE=$2; shift 2 ;;
    --http-port) need_value "$1" "${2:-}"; HTTP_PORT=$2; shift 2 ;;
    --https-port) need_value "$1" "${2:-}"; HTTPS_PORT=$2; shift 2 ;;
      --registry-port) need_value "$1" "${2:-}"; REGISTRY_PORT=$2; shift 2 ;;
      --registry-host) need_value "$1" "${2:-}"; REGISTRY_HOST=$2; shift 2 ;;
      --state-dir) need_value "$1" "${2:-}"; STATE_DIR=$2; VALUES_FILE="$STATE_DIR/values.yaml"; shift 2 ;;
      -y|--yes) ASSUME_YES=true; shift ;;
      --allow-ipv6-only) ALLOW_IPV6_ONLY=true; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage; die "unknown flag: $1" ;;
    esac
  done
}

# Fields of /proc/<pid>/stat, counted after the pid and the (comm) that may
# contain anything: 2 is the parent, 5 is the controlling terminal.
proc_stat_field() {
  local pid=$1 n=$2
  [ -r "/proc/$pid/stat" ] || return 1
  awk -v n="$n" '{ sub(/^[0-9]+ \(.*\) /, ""); print $n }' "/proc/$pid/stat" 2>/dev/null
}

# `curl | sudo bash` looks like it is working and is not: the question appears,
# the keystrokes echo, and nothing ever arrives. sudo 1.9.14 and newer run the
# command in a pty of their own (use_pty, on by default on Ubuntu 24.04), that
# pty is our /dev/tty, and because sudo's own stdin is the pipe carrying this
# script it never relays the real terminal into it. The tell is an ancestor
# sitting on a different terminal than ours; nobody is typing into ours.
tty_is_the_one_being_typed_into() {
  local ours pid t hops=0
  ours=$(proc_stat_field $$ 5) || return 0
  [ -n "$ours" ] && [ "$ours" != 0 ] || return 0
  pid=$(proc_stat_field $$ 2) || return 0
  while [ "$hops" -lt 12 ]; do
    case "$pid" in ''|*[!0-9]*) return 0 ;; esac
    [ "$pid" -gt 1 ] || return 0
    t=$(proc_stat_field "$pid" 5) || return 0
    [ -n "$t" ] || return 0
    if [ "$t" != 0 ] && [ "$t" != "$ours" ]; then return 1; fi
    pid=$(proc_stat_field "$pid" 2) || return 0
    hops=$((hops + 1))
  done
  return 0
}

# Questions go over fd 3: stdin is usually this script itself, and /dev/tty is
# only worth reading when it is the terminal someone is actually typing into.
open_prompt_fd() {
  if [ -t 0 ]; then
    { if exec 3<&0; then PROMPT_FD_OPEN=true; fi; } 2>/dev/null
    if [ "$PROMPT_FD_OPEN" = true ]; then return 0; fi
  fi

  if ! tty_is_the_one_being_typed_into; then
    PROMPT_BLOCKED="this is running on a terminal of its own, so your keystrokes cannot reach it"
    return 1
  fi

  { if exec 3</dev/tty; then PROMPT_FD_OPEN=true; fi; } 2>/dev/null
  if [ "$PROMPT_FD_OPEN" != true ]; then
    PROMPT_BLOCKED="no terminal to read an answer from"
    return 1
  fi
}

prompt_hint() {
  {
    printf '\n      %sOrchard has a few questions before it installs anything.%s\n' "$C_GREY" "$C_RESET"
    printf '      %sRun it with your terminal attached:%s\n' "$C_GREY" "$C_RESET"
    printf '        curl -fsSL %s -o orchard-install.sh && sudo bash orchard-install.sh\n' "$INSTALL_URL"
    printf '      %sor pass the answers as flags. --yes takes the default for the rest:%s\n' "$C_GREY" "$C_RESET"
    printf '        curl -fsSL %s | sudo bash -s -- --yes --mode public --domain orchard.example.com\n' "$INSTALL_URL"
    printf '\n'
  } >&2
}

ask() {
  local prompt=$1 default=${2:-} answer='' rc=0
  if [ "$ASSUME_YES" = true ]; then printf '%s' "$default"; return; fi

  if [ "$PROMPT_FD_OPEN" != true ]; then
    warn "can't ask '${prompt#"${prompt%%[![:space:]]*}"}': ${PROMPT_BLOCKED:-no terminal to read an answer from}"
    if [ "$PROMPT_HINT_SHOWN" != true ]; then prompt_hint; fi
    die "nothing has been installed yet; nothing to undo"
  fi

  # Ignored rather than default: a read from a background process group then
  # fails with EIO instead of stopping us where nobody can see it.
  trap '' TTIN TTOU

  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi

  if [ "$PROMPT_TIMEOUT" -gt 0 ]; then
    IFS= read -r -t "$PROMPT_TIMEOUT" answer <&3 2>/dev/null || rc=$?
  else
    IFS= read -r answer <&3 2>/dev/null || rc=$?
  fi
  trap - TTIN TTOU

  if [ "$rc" -ne 0 ] && [ "${ASK_SOFT:-false}" = true ]; then
    printf '\n' >&2
    printf '__eof__'
    return 0
  fi

  if [ "$rc" -ne 0 ]; then
    printf '\n' >&2
    if [ "$rc" -gt 128 ]; then
      warn "no answer after $(fmt_secs "$PROMPT_TIMEOUT"); giving up on the question"
    else
      warn "couldn't read an answer from this terminal"
    fi
    prompt_hint
    die "nothing has been installed yet; nothing to undo"
  fi

  answer=${answer%$'\r'}
  answer=${answer#"${answer%%[![:space:]]*}"}
  answer=${answer%"${answer##*[![:space:]]}"}
  printf '%s' "${answer:-$default}"
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "amd64 or arm64 only; this is $(uname -m)" ;;
  esac
}

check_memory() {
  MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' "$MEMINFO_FILE")
  if [ "$MEM_MB" -lt 1800 ]; then
    warn "${MEM_MB}Mi of memory is below 2Gi, so Orchard will leave little or no room for apps."
  elif [ "$MEM_MB" -lt "$TINY_BOX_MB" ]; then
    warn "${MEM_MB}Mi of memory: Orchard runs its smallest profile. MCP and image scanning start off, and big builds may run out of memory."
  fi
  info "memory: ${MEM_MB}Mi"
}

tiny_box_defaults() {
  [ "$MEM_MB" -lt "$TINY_BOX_MB" ] || return 0
  [ "$PREVIOUS_INSTALL" = true ] && return 0
  if ! answer_given --mcp ORCHARD_MCP && ! answer_given --mcp-domain ORCHARD_MCP_DOMAIN; then
    ORCHARD_MCP=false
  fi
  answer_given --image-scanning ORCHARD_IMAGE_SCANNING || ORCHARD_IMAGE_SCANNING=false
}

settle_image_tag() {
  local round
  if answer_given --image-tag ORCHARD_IMAGE_TAG; then return 0; fi
  if [ "$IMAGE_TAG" = latest ] && [ "$PREVIOUS_INSTALL" = true ]; then
    round=$(reuse_value '.hostDefaults')
    case "$round" in ''|*[!0-9]*) round=0 ;; esac
    if [ -n "$ORCHARD_VERSION" ] \
       || { [ "$round" -lt 3 ] && [ "$IMAGE_REGISTRY" = ghcr.io ] && [ "$IMAGE_REPOSITORY" = hackclub/orchard ] && [ ! -d "$CHART_REF" ]; }; then
      IMAGE_TAG=''
    fi
  fi
  if [ -z "$IMAGE_TAG" ] && [ -d "$CHART_REF" ]; then IMAGE_TAG=latest; fi
}

settle_pull_policy() {
  local round
  if answer_given --image-pull-policy ORCHARD_IMAGE_PULL_POLICY; then return 0; fi
  if [ "$IMAGE_PULL_POLICY" = Always ] && [ "$PREVIOUS_INSTALL" = true ]; then
    round=$(reuse_value '.hostDefaults')
    case "$round" in ''|*[!0-9]*) round=0 ;; esac
    if [ "$round" -lt 4 ]; then IMAGE_PULL_POLICY=''; fi
  fi
  if [ -z "$IMAGE_PULL_POLICY" ] && [ "$IMAGE_TAG" = latest ]; then IMAGE_PULL_POLICY=Always; fi
}

check_image_tag() {
  answer_given --image-tag ORCHARD_IMAGE_TAG || return 0
  [[ "$IMAGE_TAG" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 0
  die "--image-tag $IMAGE_TAG is a release version, and the server and frontend are versioned separately. To install that release, use --chart-version ${IMAGE_TAG#v}"
}

answer_given() {
  case "$FLAGS_GIVEN" in *" $1 "*) return 0 ;; esac
  case "$ENV_AT_START" in *" $2 "*) [ -n "${!2:-}" ] && return 0 ;; esac
  return 1
}

keep_answer() {
  local flag=$1 env_name=$2 target=$3 path=$4 value
  if answer_given "$flag" "$env_name"; then return 0; fi
  value=$(reuse_value "$path")
  if [ -n "$value" ]; then printf -v "$target" '%s' "$value"; fi
}

previous_ingress_mode() {
  if [ "$(reuse_value '.ingress.tls.enabled')" = true ]; then
    printf public
    return
  fi
  case "$(reuse_secret FRONTEND_URL)" in
    https://*) printf tunnel ;;
    http://*) printf lan ;;
  esac
}

is_sslip() {
  case "$1" in *.sslip.io) return 0 ;; *) return 1 ;; esac
}

read_live_settings() {
  local live line
  PREV_PUBLIC_IP=$(reuse_value '.tenant.publicIp')
  PREV_CNAME=$(reuse_secret INGRESS_CNAME)
  PREV_EMAIL=$(KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl --request-timeout=10s get clusterissuer letsencrypt \
    -o jsonpath='{.spec.acme.email}' 2>/dev/null || true)
  live=$(KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n orchard exec deploy/server --request-timeout=20s -- \
    node dist/scripts/install-settings.js show 2>/dev/null || true)
  while IFS= read -r line; do
    case "$line" in
      publicIp=?*) if [ -z "$PREV_PUBLIC_IP" ]; then PREV_PUBLIC_IP=${line#publicIp=}; fi ;;
      cname=?*) if [ -z "$PREV_CNAME" ]; then PREV_CNAME=${line#cname=}; fi ;;
    esac
  done <<EOF
$live
EOF
}

keep_previous_answers() {
  keep_answer --domain ORCHARD_DOMAIN ORCHARD_DOMAIN '.ingress.host'
  if [ "$MOVING_OFF_SSLIP" = false ]; then
    keep_answer --app-domain ORCHARD_APP_DOMAIN ORCHARD_APP_DOMAIN '.server.env[]? | select(.name == "APP_DOMAIN") | .value'
    keep_answer --mcp-domain ORCHARD_MCP_DOMAIN ORCHARD_MCP_DOMAIN '.mcp.ingress.host'
  fi
  keep_answer --mcp ORCHARD_MCP ORCHARD_MCP '.mcp.enabled'
  keep_answer --metrics ORCHARD_METRICS ORCHARD_METRICS '.metrics.enabled'
  keep_answer --logs ORCHARD_LOGS ORCHARD_LOGS '.logs.enabled'
  keep_answer --image-scanning ORCHARD_IMAGE_SCANNING ORCHARD_IMAGE_SCANNING '.trivy.enabled'
  keep_answer --object-storage ORCHARD_OBJECT_STORAGE ORCHARD_OBJECT_STORAGE '.objectStorage.local.enabled'
  keep_answer --http-port ORCHARD_HTTP_PORT HTTP_PORT '.server.env[]? | select(.name == "PUBLIC_HTTP_PORT") | .value'
  keep_answer --https-port ORCHARD_HTTPS_PORT HTTPS_PORT '.server.env[]? | select(.name == "PUBLIC_HTTPS_PORT") | .value'
  keep_answer --registry-host ORCHARD_REGISTRY_HOST REGISTRY_HOST '.server.env[]? | select(.name == "DOCKER_REGISTRY_PULL") | .value'
  keep_answer --image-registry ORCHARD_IMAGE_REGISTRY IMAGE_REGISTRY '.image.registry'
  keep_answer --image-repository ORCHARD_IMAGE_REPOSITORY IMAGE_REPOSITORY '.image.repository'
  keep_answer --image-pull-policy ORCHARD_IMAGE_PULL_POLICY IMAGE_PULL_POLICY '.image.pullPolicy'
  keep_answer --image-tag ORCHARD_IMAGE_TAG IMAGE_TAG '.server.image.tag'
}

load_previous_answers() {
  [ -f "$VALUES_FILE" ] || return 0
  PREVIOUS_INSTALL=true

  if ! command -v yq >/dev/null 2>&1; then
    detect_arch
    ensure_yq
  fi
  require_readable_values

  PREV_MODE=$(previous_ingress_mode)
  if ! answer_given --mode ORCHARD_INGRESS_MODE; then
    ORCHARD_INGRESS_MODE=$PREV_MODE
  fi

  PREV_DOMAIN=$(reuse_value '.ingress.host')
  PREV_APP_DOMAIN=$(reuse_secret APP_DOMAIN)
  PREV_MCP=$(reuse_value '.mcp.enabled')
  PREV_MCP_DOMAIN=$(reuse_value '.mcp.ingress.host')
  if answer_given --domain ORCHARD_DOMAIN && is_sslip "$PREV_DOMAIN" && ! is_sslip "$ORCHARD_DOMAIN"; then
    MOVING_OFF_SSLIP=true
  fi
  PREV_UPDATES=manual
  if systemctl is-enabled --quiet orchard-update.timer 2>/dev/null; then PREV_UPDATES=automatic; fi

  read_live_settings
  if ! answer_given --public-ip ORCHARD_PUBLIC_IP; then ORCHARD_PUBLIC_IP=$PREV_PUBLIC_IP; fi
  if ! answer_given --ingress-cname ORCHARD_INGRESS_CNAME; then ORCHARD_INGRESS_CNAME=$PREV_CNAME; fi
  if ! answer_given --email ORCHARD_ACME_EMAIL; then ORCHARD_ACME_EMAIL=$PREV_EMAIL; fi

  keep_previous_answers

  PREVIOUS_EXTRA_HOSTS=$(yq -r '.ingress.extraHosts[]?' "$VALUES_FILE" 2>/dev/null | tr '\n' ' ')

  if [ "$ORCHARD_INGRESS_MODE" = tunnel ] && [ -z "$ORCHARD_TUNNEL_TOKEN" ]; then
    ORCHARD_TUNNEL_TOKEN=$(KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n cloudflared get secret tunnel-token \
      -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || true)
  fi
}

preflight() {
  step

  [ "$(id -u)" -eq 0 ] || die "run as root (k3s needs it)"
  [ "$(uname -s)" = Linux ] || die "Linux only; this is $(uname -s)"

  detect_arch
  info "architecture: $ARCH"

  command -v openssl >/dev/null 2>&1 \
    || die "the installer needs openssl to create the database backup plugin's certificates. Install it and run the installer again"
  if [ -n "$RELEASE_KEYS" ] && [ "$(unsigned_commands_allowed)" != true ] && ! openssl_checks_signatures; then
    die "the installer checks release signatures and needs OpenSSL 3 or newer. Upgrade it, or set ORCHARD_ALLOW_UNSIGNED_COMMANDS=true to install without the check"
  fi

  check_memory
  tiny_box_defaults

  DISK_GB=$(df -BG --output=avail /var/lib 2>/dev/null | tail -1 | tr -dc '0-9')
  DISK_GB=${DISK_GB:-0}
  [ "$DISK_GB" -ge 20 ] || [ -d "$STATE_DIR" ] || die "need at least 20G free on /var/lib, found ${DISK_GB}G"
  [ "$DISK_GB" -ge 60 ] || warn "only ${DISK_GB}G free; build cache and images will fill this quickly"
  info "free disk: ${DISK_GB}G"

  local port
  for port in "$HTTP_PORT" "$HTTPS_PORT"; do
    case "$port" in ''|*[!0-9]*) die "ports are numbers, not: $port" ;; esac
    { [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; } || die "port out of range: $port"
  done
  [ "$HTTP_PORT" != "$HTTPS_PORT" ] || die "--http-port and --https-port cannot both be $HTTP_PORT"
  [ "$HTTP_PORT" = 80 ] || HTTP_SUFFIX=":$HTTP_PORT"
  [ "$HTTPS_PORT" = 443 ] || HTTPS_SUFFIX=":$HTTPS_PORT"

  # Not fatal here: tunnel mode never binds either port, and the mode is not
  # chosen until the next step. check_mode_constraints stops the run if the mode
  # that gets picked does need them.
  if command -v ss >/dev/null 2>&1; then
    local holder
    for port in "$HTTP_PORT" "$HTTPS_PORT"; do
      if ss -lnt "sport = :$port" 2>/dev/null | grep -q LISTEN; then
        holder=$(ss -lntp "sport = :$port" 2>/dev/null | tail -1 | sed 's/^ *//')
        PORTS_BUSY="${PORTS_BUSY:+$PORTS_BUSY and }$port"
        PORTS_BUSY_DETAIL="${PORTS_BUSY_DETAIL}      $holder"$'\n'
      fi
    done
    if [ -n "$PORTS_BUSY" ]; then
      warn "port $PORTS_BUSY already in use:"
      printf '%s' "$PORTS_BUSY_DETAIL" >&2
    else
      info "ports $HTTP_PORT/$HTTPS_PORT are free"
    fi
  else
    warn "ss not found; skipping port check"
  fi

  if [ ! -d "$STATE_DIR" ] && command -v kubectl >/dev/null 2>&1 && kubectl cluster-info >/dev/null 2>&1; then
    warn "an existing Kubernetes cluster is reachable from this shell."
    warn "This installer creates its own k3s cluster and won't touch it."
    warn "To install into that cluster instead, use the Helm chart: https://docs.orchard.hackclub.com/start/install/#install-on-an-existing-cluster"
    if [ "$(ask 'Continue and create a new k3s cluster? (yes/no)' no)" != yes ]; then
      die "stopped so the existing cluster is left alone"
    fi
  fi

  if [ ! -f /sys/fs/cgroup/cgroup.controllers ]; then
    warn "cgroup v2 not detected; resource limits may not be enforced"
  fi

  if [ -w /dev/kvm ]; then
    info "KVM present: after install, 'orchardctl fast-builder enable --apply' turns on the fast builder"
  fi

  local lo=${NODE_PORT_RANGE%-*} hi=${NODE_PORT_RANGE#*-}
  for port in "$HTTP_PORT" "$HTTPS_PORT" "$REGISTRY_PORT"; do
    if [ "$port" -ge "$lo" ] && [ "$port" -le "$hi" ]; then
      die "port $port falls inside ORCHARD_NODE_PORT_RANGE ($NODE_PORT_RANGE), where Kubernetes hands out its own"
    fi
  done
  if command -v ss >/dev/null 2>&1 && ss -lnt "sport = :$REGISTRY_PORT" 2>/dev/null | grep -q LISTEN; then
    if ! kubectl -n orchard get deploy zot >/dev/null 2>&1; then
      die "port $REGISTRY_PORT is already in use on this machine; pick another with --registry-port"
    fi
  fi
  info "node ports: $NODE_PORT_RANGE, registry on 127.0.0.1:$REGISTRY_PORT"
}

is_ipv4() {
  local a b c d
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]}
  [ "$a" -le 255 ] && [ "$b" -le 255 ] && [ "$c" -le 255 ] && [ "$d" -le 255 ]
}

is_ipv6() {
  case "$1" in *:*) ;; *) return 1 ;; esac
  [[ "$1" =~ ^[0-9a-fA-F:.]+$ ]]
}

is_ip() {
  is_ipv4 "$1" || is_ipv6 "$1"
}

ipv4_to_int() {
  local IFS=.
  # shellcheck disable=SC2086  # splitting on dots is the point
  set -- $1
  printf '%d' $((($1 << 24) + ($2 << 16) + ($3 << 8) + $4))
}

ipv4_in_cidr() {
  local ip=$1 net=${2%/*} bits=${2#*/} mask
  mask=$(((0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF))
  [ $(($(ipv4_to_int "$ip") & mask)) -eq $(($(ipv4_to_int "$net") & mask)) ]
}

is_private_ip() {
  local cidr
  if is_ipv4 "$1"; then
    for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16; do
      if ipv4_in_cidr "$1" "$cidr"; then return 0; fi
    done
    return 1
  fi
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    fc*|fd*|fe8*|fe9*|fea*|feb*|::1) return 0 ;;
  esac
  return 1
}

is_cloudflare_ip() {
  local cidr
  if is_ipv4 "$1"; then
    for cidr in 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 \
      108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 \
      162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22; do
      if ipv4_in_cidr "$1" "$cidr"; then return 0; fi
    done
    return 1
  fi
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    2400:cb00:*|2606:4700:*|2803:f800:*|2405:b500:*|2405:8100:*|2a06:98c?:*|2c0f:f248:*) return 0 ;;
  esac
  return 1
}

clean_host() {
  local host
  host=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  host=${host#http://}
  host=${host#https://}
  host=${host%%/*}
  host=${host#\*.}
  host=${host%.}
  printf '%s' "$host"
}

valid_host() {
  [ "${#1}" -le 253 ] || return 1
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] || return 1
  if is_ipv4 "$1"; then return 1; fi
  return 0
}

valid_lan_host() {
  if is_ip "$1"; then return 0; fi
  if [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then return 0; fi
  valid_host "$1"
}

email_problem() {
  case "$1" in
    *[[:space:]]*|*\"*|*\'*|*:*) printf "that isn't an email address"; return ;;
    *@*.*) ;;
    *) printf "that isn't an email address"; return ;;
  esac
  case "${1##*@}" in
    example.com|example.org|example.net|*.example.com|*.example.org|*.example.net|*.local|*.test|*.invalid|*.localhost)
      printf "Let's Encrypt refuses addresses at %s, and no certificate would issue" "${1##*@}"
      ;;
  esac
}

sslip_name() {
  local label=$1 ip=$2 dashed
  if is_ipv6 "$ip"; then
    dashed=${ip//:/-}
    case "$dashed" in *-) dashed="${dashed}0" ;; esac
    case "$dashed" in -*) dashed="0$dashed" ;; esac
  else
    dashed=${ip//./-}
  fi
  printf '%s.%s.sslip.io' "$label" "$dashed"
}

cloud_provider() {
  local dir=$DMI_DIR vendor asset
  vendor=$(cat "$dir/sys_vendor" 2>/dev/null || true)
  asset=$(cat "$dir/chassis_asset_tag" 2>/dev/null || true)
  case "$asset" in OracleCloud*) printf oracle; return ;; esac
  case "$vendor" in
    Amazon*) printf aws ;;
    Google*) printf gcp ;;
    Microsoft*) printf azure ;;
    Hetzner*) printf hetzner ;;
    DigitalOcean*) printf digitalocean ;;
    Linode*|Akamai*) printf linode ;;
    Vultr*) printf vultr ;;
    OVH*) printf ovh ;;
  esac
}

firewall_hint() {
  case "$CLOUD" in
    aws) printf 'On AWS, allow 80 and 443 in the security group: EC2 > Security Groups > Inbound rules.' ;;
    gcp) printf 'On Google Cloud, allow 80 and 443 in VPC network > Firewall.' ;;
    azure) printf "On Azure, allow 80 and 443 in the VM's network security group." ;;
    hetzner) printf 'On Hetzner, allow 80 and 443 in Cloud Console > Firewalls, if one is attached.' ;;
    digitalocean) printf 'On DigitalOcean, allow 80 and 443 in Networking > Firewalls, if one is attached.' ;;
    oracle) printf 'On Oracle Cloud, allow 80 and 443 in the VCN security list, and in the iptables rules on the machine.' ;;
    linode) printf 'On Linode, allow 80 and 443 in the Cloud Firewall, if one is attached.' ;;
    vultr) printf 'On Vultr, allow 80 and 443 in the firewall group, if one is attached.' ;;
    ovh) printf 'On OVH, allow 80 and 443 in the Edge Network Firewall, if it is on.' ;;
    *) printf "Allow 80 and 443 in your provider's firewall, or forward them on your router." ;;
  esac
}

detect_public_ipv4() {
  local url ip
  for url in https://api.ipify.org https://ipv4.icanhazip.com; do
    ip=$(curl -4 -fsS --max-time 6 "$url" 2>/dev/null | tr -d '[:space:]' || true)
    if is_ipv4 "$ip"; then printf '%s' "$ip"; return 0; fi
  done
  return 0
}

detect_public_ipv6() {
  local ip
  ip=$(curl -6 -fsS --max-time 4 https://api6.ipify.org 2>/dev/null | tr -d '[:space:]' || true)
  if is_ipv6 "$ip"; then printf '%s' "$ip"; fi
  return 0
}

host_addresses() {
  ip "-$1" -o addr show scope global 2>/dev/null \
    | awk '$2 !~ /^(docker|br-|cni|flannel|veth|virbr|lo)/ {print $4}' | cut -d/ -f1 || true
}

ip_is_local() {
  local candidate
  for candidate in $LOCAL_IPS $LOCAL_IPS6; do
    if [ "$candidate" = "$1" ]; then return 0; fi
  done
  return 1
}

detect_network() {
  step

  PUBLIC_IP=$(detect_public_ipv4)
  PUBLIC_IP6=$(detect_public_ipv6)
  LOCAL_IPS=$(host_addresses 4)
  LOCAL_IPS6=$(host_addresses 6)
  PRIMARY_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' || true)
  if [ -z "$PRIMARY_IP" ]; then PRIMARY_IP=$(printf '%s\n' "$LOCAL_IPS" | head -1); fi
  CLOUD=$(cloud_provider)

  if [ -z "$PUBLIC_IP" ]; then
    local candidate
    for candidate in $LOCAL_IPS; do
      if ! is_private_ip "$candidate"; then PUBLIC_IP=$candidate; break; fi
    done
  fi

  BEHIND_NAT=true
  if [ -n "$PUBLIC_IP" ] && ip_is_local "$PUBLIC_IP"; then BEHIND_NAT=false; fi
  if [ -z "$PUBLIC_IP" ] && [ -n "$PUBLIC_IP6" ] && ip_is_local "$PUBLIC_IP6"; then BEHIND_NAT=false; fi

  info "public IP: ${PUBLIC_IP:-${PUBLIC_IP6:-not found}}"
  info "local IP:  ${PRIMARY_IP:-${LOCAL_IPS6:-not found}}"
  if [ -n "$CLOUD" ]; then info "provider:  $CLOUD"; fi
}

has_only_ipv6() {
  [ -z "$PUBLIC_IP$PRIMARY_IP$LOCAL_IPS" ] && [ -n "$PUBLIC_IP6$LOCAL_IPS6" ]
}

require_ipv4() {
  has_only_ipv6 || return 0

  warn "IPv6-only servers aren't supported yet. This server has no IPv4 address."
  note "GitHub and ghcr.io have no IPv6 addresses, so this server can't download k3s"
  note "or the Orchard images, and Orchard can't clone or build from GitHub."
  note "k3s runs with IPv4 inside the cluster, and Orchard listens on IPv4 only, so"
  note "traffic to the IPv6 address of this server doesn't reach it."
  printf '\n'
  note "Use a server with an IPv4 address. NAT64 in front of an IPv4 server also works"
  note "in principle, but it is unsupported and untested."
  if [ "$ALLOW_IPV6_ONLY" = true ]; then
    warn "Continuing because of --allow-ipv6-only."
    return 0
  fi
  note "To try anyway, run the installer again with --allow-ipv6-only."
  die "stopped before installing anything"
}

recommended_mode() {
  if [ -z "$PUBLIC_IP$PUBLIC_IP6" ]; then printf lan; return; fi
  if [ "$BEHIND_NAT" = false ] || [ -n "$CLOUD" ]; then printf public; return; fi
  printf tunnel
}

recommended_reason() {
  if [ -z "$PUBLIC_IP$PUBLIC_IP6" ]; then
    printf 'No public address was found, so this machine looks private.'
    return
  fi
  if [ "$BEHIND_NAT" = false ]; then
    printf '%s is on this machine.' "${PUBLIC_IP:-$PUBLIC_IP6}"
    return
  fi
  if [ -n "$CLOUD" ]; then
    printf 'This looks like a cloud server: %s maps to %s on this machine.' "${PUBLIC_IP:-$PUBLIC_IP6}" "${PRIMARY_IP:-a private address}"
    return
  fi
  printf 'This machine is behind NAT: it is %s, and the internet sees %s.' "${PRIMARY_IP:-a private address}" "${PUBLIC_IP:-$PUBLIC_IP6}"
}

check_mode_constraints() {
  case "$INGRESS_MODE" in
    public|tunnel|lan) ;;
    *) die "--mode takes public, tunnel or lan, not: $INGRESS_MODE" ;;
  esac

  if [ "$INGRESS_MODE" != lan ] && { [ "$HTTP_PORT" != 80 ] || [ "$HTTPS_PORT" != 443 ]; }; then
    case "$INGRESS_MODE" in
      public)
        warn "public mode can't move off 80 and 443."
        note "The ACME HTTP-01 challenge requires port 80, and a browser reaching an app"
        note "on any port but 443 needs the port in its URL."
        die "custom ports are lan only" ;;
      tunnel)
        warn "tunnel mode binds no host port, so there is nothing to move."
        die "custom ports are lan only" ;;
    esac
  fi

  if [ -n "$PORTS_BUSY" ] && [ "$INGRESS_MODE" != tunnel ]; then
    warn "$INGRESS_MODE mode needs 80 and 443 on this machine, and port $PORTS_BUSY is taken:"
    printf '%s' "$PORTS_BUSY_DETAIL" >&2
    note "Free it, move whatever holds it, or install in tunnel mode"
    note "(--mode tunnel), which binds nothing on this machine."
    die "stopped before installing anything"
  fi
}

# Every other name this box answers to, so Traefik routes on all of them rather
# than 404ing on the one the person actually typed. Its own IPs (including the
# Tailscale one), its hostname, its mDNS name, and the sslip.io name earlier
# versions used.
lan_alt_hosts() {
  local short sslip=''
  short=$(hostname 2>/dev/null | cut -d. -f1 || true)
  if [ -n "$PRIMARY_IP" ]; then sslip=$(sslip_name orchard "$PRIMARY_IP"); fi
  # shellcheck disable=SC2086  # each of these is a list of names
  extra_hosts_list $PREVIOUS_EXTRA_HOSTS $LOCAL_IPS $short ${short:+$short.local} $sslip
}

extra_hosts_list() {
  local out='' seen=' ' candidate
  for candidate in "$@"; do
    [ -n "$candidate" ] || continue
    [ "$candidate" != "$ORCHARD_DOMAIN" ] || continue
    case "$seen" in *" $candidate "*) continue ;; esac
    seen="$seen$candidate "
    out="${out:+$out, }\"$candidate\""
  done
  printf '[%s]' "$out"
}

parent_domain() {
  local host=$1 rest=${1#*.}
  case "$rest" in *.*) ;; *) printf '%s' "$host"; return ;; esac
  case "$host" in
    *.*.*.*) ;;
    *.co.??|*.com.??|*.org.??|*.net.??|*.ac.??|*.gov.??|*.edu.??) printf '%s' "$host"; return ;;
  esac
  printf '%s' "$rest"
}

covered_by_app_wildcard() {
  local label=${1%".$ORCHARD_APP_DOMAIN"}
  [ "$label" != "$1" ] || return 1
  case "$label" in *.*) return 1 ;; esac
  return 0
}

tunnel_id() {
  printf '%s' "$ORCHARD_TUNNEL_TOKEN" | base64 -d 2>/dev/null \
    | sed -n 's/.*"t":"\([0-9a-fA-F-]*\)".*/\1/p' || true
}

ingress_cname() {
  local id
  case "$INGRESS_MODE" in
    public) printf '%s' "$ORCHARD_DOMAIN" ;;
    tunnel)
      id=$(tunnel_id)
      if [ -n "$id" ]; then printf '%s.cfargotunnel.com' "$id"; fi
      ;;
    lan)
      if [ -n "$PRIMARY_IP" ]; then sslip_name orchard "$PRIMARY_IP"; fi
      ;;
  esac
}

lan_name_base() {
  if [ -n "$PRIMARY_IP" ]; then
    sslip_name x "$PRIMARY_IP" | cut -d. -f2-
  else
    parent_domain "$ORCHARD_DOMAIN"
  fi
}

default_domain() {
  case "$INGRESS_MODE" in
    lan) printf '%s' "${PRIMARY_IP:-localhost}" ;;
    public)
      if [ -n "$ORCHARD_PUBLIC_IP" ] && ! is_private_ip "$ORCHARD_PUBLIC_IP"; then
        sslip_name orchard "$ORCHARD_PUBLIC_IP"
      fi
      ;;
  esac
}

default_app_domain() {
  [ -n "$ORCHARD_DOMAIN" ] || return 0
  case "$INGRESS_MODE" in
    lan) printf 'apps.%s' "$(lan_name_base)" ;;
    tunnel) parent_domain "$ORCHARD_DOMAIN" ;;
    *) printf 'apps.%s' "$(parent_domain "$ORCHARD_DOMAIN")" ;;
  esac
}

default_mcp_domain() {
  [ -n "$ORCHARD_DOMAIN" ] || return 0
  local base
  if [ "$INGRESS_MODE" = lan ]; then
    base=$(lan_name_base)
  else
    base=$(parent_domain "$ORCHARD_DOMAIN")
  fi
  if [ "mcp.$base" = "$ORCHARD_DOMAIN" ]; then
    printf 'agents.%s' "$base"
  else
    printf 'mcp.%s' "$base"
  fi
}

default_public_ip() {
  case "$INGRESS_MODE" in
    public) printf '%s' "${PUBLIC_IP:-$PUBLIC_IP6}" ;;
    lan) printf '%s' "$PRIMARY_IP" ;;
  esac
}

mark_given_answers() {
  if [ "$ORCHARD_PUBLIC_IP" = none ]; then ORCHARD_PUBLIC_IP=''; PUBLIC_IP_SET=true; fi
  if [ "$ORCHARD_INGRESS_CNAME" = none ]; then ORCHARD_INGRESS_CNAME=''; CNAME_SET=true; fi
  if [ "$ORCHARD_ACME_EMAIL" = none ]; then ORCHARD_ACME_EMAIL=''; fi
  if [ -n "$ORCHARD_PUBLIC_IP" ]; then PUBLIC_IP_SET=true; fi
  if [ -n "$ORCHARD_DOMAIN" ]; then
    DOMAIN_SET=true
    ORCHARD_DOMAIN=$(clean_host "$ORCHARD_DOMAIN")
  fi
  if [ -n "$ORCHARD_APP_DOMAIN" ]; then
    APP_DOMAIN_SET=true
    ORCHARD_APP_DOMAIN=$(clean_host "$ORCHARD_APP_DOMAIN")
  fi
  if [ -n "$ORCHARD_MCP_DOMAIN" ]; then
    MCP_DOMAIN_SET=true
    ORCHARD_MCP_DOMAIN=$(clean_host "$ORCHARD_MCP_DOMAIN")
  fi
  if [ -n "$ORCHARD_INGRESS_CNAME" ]; then
    CNAME_SET=true
    ORCHARD_INGRESS_CNAME=$(clean_host "$ORCHARD_INGRESS_CNAME")
  fi
}

derive_answers() {
  if [ "$PUBLIC_IP_SET" != true ]; then ORCHARD_PUBLIC_IP=$(default_public_ip); fi
  if [ "$DOMAIN_SET" != true ]; then ORCHARD_DOMAIN=$(default_domain); fi
  if [ "$APP_DOMAIN_SET" != true ]; then ORCHARD_APP_DOMAIN=$(default_app_domain); fi
  if [ "$MCP_DOMAIN_SET" != true ]; then ORCHARD_MCP_DOMAIN=$(default_mcp_domain); fi
  if [ "$CNAME_SET" != true ]; then ORCHARD_INGRESS_CNAME=$(ingress_cname); fi
}

apply_mode_settings() {
  # shellcheck disable=SC2086  # a list of names
  INGRESS_EXTRA_HOSTS=$(extra_hosts_list $PREVIOUS_EXTRA_HOSTS)
  case "$INGRESS_MODE" in
    public) USE_TLS=true; CERT_ISSUER=letsencrypt ;;
    tunnel) USE_TLS=false; CERT_ISSUER='' ;;
    lan)
      USE_TLS=false
      CERT_ISSUER=selfsigned
      INGRESS_EXTRA_HOSTS=$(lan_alt_hosts)
      ;;
  esac
}

host_problem() {
  local value=$1 flag=$2
  if ! valid_host "$value"; then printf '%s is not a hostname. %s takes a name such as orchard.example.com' "$value" "$flag"; fi
}

validate_answers() {
  case "$ORCHARD_LIMITS" in
    ''|on|off) ;;
    *) die "--limits takes on or off, not: $ORCHARD_LIMITS" ;;
  esac
  case "$ORCHARD_MCP" in
    true|false) ;;
    *) die "--mcp takes true or false, not: $ORCHARD_MCP" ;;
  esac
  case "$ORCHARD_UPDATE_POLICY" in
    manual|automatic|'') ;;
    *) die "--updates takes manual or automatic, not: $ORCHARD_UPDATE_POLICY" ;;
  esac
  if [ -n "$ORCHARD_PUBLIC_IP" ] && ! is_ip "$ORCHARD_PUBLIC_IP"; then
    die "--public-ip takes an IP address or none, not: $ORCHARD_PUBLIC_IP"
  fi

  if [ "$INGRESS_MODE" = tunnel ] && [ -z "$ORCHARD_TUNNEL_TOKEN" ]; then
    die "tunnel mode needs a token: pass --tunnel-token or set ORCHARD_TUNNEL_TOKEN"
  fi
  if [ -z "$ORCHARD_DOMAIN" ]; then
    case "$INGRESS_MODE" in
      tunnel) die "tunnel mode needs a domain: pass --domain or set ORCHARD_DOMAIN" ;;
      public) die "public mode needs a domain, or an address to name one after: pass --domain or --public-ip" ;;
    esac
  fi

  local problem
  if [ "$INGRESS_MODE" = lan ]; then
    if ! valid_lan_host "$ORCHARD_DOMAIN"; then die "$ORCHARD_DOMAIN is not an address or a hostname: check --domain"; fi
  else
    problem=$(host_problem "$ORCHARD_DOMAIN" --domain)
    if [ -n "$problem" ]; then die "$problem"; fi
  fi
  problem=$(host_problem "$ORCHARD_APP_DOMAIN" --app-domain)
  if [ -n "$problem" ]; then die "$problem"; fi
  if [ "$ORCHARD_MCP" = true ]; then
    problem=$(host_problem "$ORCHARD_MCP_DOMAIN" --mcp-domain)
    if [ -n "$problem" ]; then die "$problem"; fi
    if [ "$ORCHARD_MCP_DOMAIN" = "$ORCHARD_DOMAIN" ]; then
      die "the MCP endpoint and the dashboard can't share $ORCHARD_DOMAIN: change --mcp-domain"
    fi
  fi
  if [ -n "$ORCHARD_INGRESS_CNAME" ]; then
    problem=$(host_problem "$ORCHARD_INGRESS_CNAME" --ingress-cname)
    if [ -n "$problem" ]; then die "$problem"; fi
  fi
  if [ -n "$ORCHARD_ACME_EMAIL" ]; then
    problem=$(email_problem "$ORCHARD_ACME_EMAIL")
    if [ -n "$problem" ]; then die "--email: $problem"; fi
  fi
}

Q_N=0
Q_TOTAL=0
FIRST_PASS=false

q_head() {
  Q_N=$((Q_N + 1))
  printf '\n'
  if [ "$Q_TOTAL" -gt 0 ]; then
    printf '  %s%s%d of %d%s  %s%s%s\n' "$C_BRAND" "$C_BOLD" "$Q_N" "$Q_TOTAL" "$C_RESET" "$C_BOLD" "$1" "$C_RESET"
  else
    printf '  %s%s%s\n' "$C_BOLD" "$1" "$C_RESET"
  fi
}

ask_yes_no() {
  local prompt=$1 default=$2 hint='y/N' attempt=0 answer
  if [ "$default" = yes ]; then hint='Y/n'; fi
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    answer=$(ask "$prompt ($hint)")
    case "$answer" in
      '') printf '%s' "$default"; return ;;
      y|Y|yes|YES|Yes) printf yes; return ;;
      n|N|no|NO|No) printf no; return ;;
    esac
    warn "answer y or n"
  done
  printf '%s' "$default"
}

on_mode_changed() {
  if [ "$PUBLIC_IP_SET" != true ]; then ORCHARD_PUBLIC_IP=$(default_public_ip); fi
  if [ "$DOMAIN_SET" = true ] && [ "$INGRESS_MODE" != lan ] && is_ip "$ORCHARD_DOMAIN"; then
    DOMAIN_SET=false
    ORCHARD_DOMAIN=''
  fi
  CNAME_SET=false
  derive_answers
  [ "$FIRST_PASS" != true ] || return 0
  if [ "$INGRESS_MODE" = tunnel ] && [ -z "$ORCHARD_TUNNEL_TOKEN" ]; then q_tunnel_token; fi
  if [ -z "$ORCHARD_DOMAIN" ]; then q_domain; fi
}

q_mode() {
  local recommended default attempt=0 choice previous=${INGRESS_MODE:-}
  recommended=$(recommended_mode)
  default=${previous:-$recommended}
  q_head "How should traffic reach this machine?"
  note "1) public   This machine has a public address. Let's Encrypt issues certificates."
  note "2) tunnel   Cloudflare Tunnel. Works behind NAT, opens no ports, needs a Cloudflare domain."
  note "3) lan      A private network or Tailscale. No public DNS, and the dashboard uses plain HTTP."
  note "Recommended: $recommended. $(recommended_reason)"
  if [ -n "$PORTS_BUSY" ]; then
    note "Port $PORTS_BUSY is taken on this machine. public and lan need 80 and 443. tunnel needs neither."
  fi
  INGRESS_MODE=''
  while [ -z "$INGRESS_MODE" ] && [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    choice=$(ask "      Mode" "$default")
    case "$choice" in
      1|public) INGRESS_MODE=public ;;
      2|tunnel) INGRESS_MODE=tunnel ;;
      3|lan) INGRESS_MODE=lan ;;
      *) warn "pick 1, 2 or 3" ;;
    esac
  done
  [ -n "$INGRESS_MODE" ] || die "no mode chosen; nothing has been installed"
  check_mode_constraints
  ORCHARD_INGRESS_MODE=$INGRESS_MODE
  if [ "$INGRESS_MODE" != "$previous" ]; then on_mode_changed; fi
}

q_tunnel_token() {
  local attempt=0
  q_head "Cloudflare Tunnel token"
  note "In Cloudflare, go to Zero Trust > Networks > Tunnels, create a tunnel, and copy its token."
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    ORCHARD_TUNNEL_TOKEN=$(ask "      Token" "$ORCHARD_TUNNEL_TOKEN")
    if [ -n "$ORCHARD_TUNNEL_TOKEN" ]; then break; fi
    warn "tunnel mode can't run without a token"
  done
  [ -n "$ORCHARD_TUNNEL_TOKEN" ] || die "--tunnel-token is required for tunnel mode"
  if [ -z "$(tunnel_id)" ]; then
    warn "That doesn't look like a tunnel token, so the tunnel ID is unknown."
  fi
  if [ "$CNAME_SET" != true ]; then ORCHARD_INGRESS_CNAME=$(ingress_cname); fi
}

q_public_ip() {
  local default attempt=0 answer
  q_head "Public IP"
  case "$INGRESS_MODE" in
    public)
      note "Public TCP and UDP ports and public databases use this address."
      ;;
    lan)
      note "The address on your network for public TCP and UDP ports and databases."
      ;;
    tunnel)
      note "Tunnel mode carries web traffic only, so most tunnel installs leave this blank."
      note "Set it only if this machine also has a public address for TCP and UDP ports."
      ;;
  esac
  if [ "$INGRESS_MODE" != tunnel ] && [ "$BEHIND_NAT" = true ] && [ -n "$PUBLIC_IP$PUBLIC_IP6" ] && [ -n "$PRIMARY_IP" ]; then
    note "This machine is $PRIMARY_IP and the internet sees ${PUBLIC_IP:-$PUBLIC_IP6}. That is normal"
    note "with 1:1 NAT on a cloud server, or behind a router. Traffic must still reach this machine."
  fi
  local addresses
  addresses=$(printf '%s ' $LOCAL_IPS $LOCAL_IPS6)
  case "${addresses% }" in
    *' '*) note "Addresses on this machine: ${addresses% }" ;;
  esac
  if [ -z "$PUBLIC_IP" ] && [ -n "$PUBLIC_IP6" ]; then
    warn "No public IPv4 address was found, only ${PUBLIC_IP6}. Orchard listens on IPv4 only."
    note "Type a public IPv4 address if this machine has one."
  fi
  if [ -z "$PUBLIC_IP$PUBLIC_IP6" ] && [ "$INGRESS_MODE" = public ]; then
    note "No public address was found. Type it if you know it."
  fi
  note "Press Enter to accept. Type none to leave it blank: public ports and databases"
  note "stay unavailable until you set it under Instance admin."
  default=$ORCHARD_PUBLIC_IP
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    answer=$(ask "      Public IP" "$default")
    case "$answer" in
      none|'')
        ORCHARD_PUBLIC_IP=''
        PUBLIC_IP_SET=true
        derive_answers
        return
        ;;
    esac
    if is_ip "$answer"; then
      if [ "$answer" != "$default" ]; then PUBLIC_IP_SET=true; fi
      ORCHARD_PUBLIC_IP=$answer
      if [ "$INGRESS_MODE" = public ] && is_private_ip "$answer"; then
        warn "$answer is a private address. Let's Encrypt can't reach it, so certificates won't issue."
      fi
      derive_answers
      return
    fi
    warn "that isn't an IP address"
  done
  die "no valid public IP; nothing has been installed"
}

ask_host() {
  local prompt=$1 default=$2 attempt=0 answer cleaned
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    answer=$(ask "$prompt" "$default")
    cleaned=$(clean_host "$answer")
    if [ -n "$cleaned" ] && valid_host "$cleaned"; then
      printf '%s' "$cleaned"
      return
    fi
    warn "enter a full name, such as orchard.example.com"
  done
  die "no valid hostname; nothing has been installed"
}

on_domain_changed() {
  local old=$1 base=''
  if [ -n "$old" ] && ! is_ip "$old"; then base=$(parent_domain "$old"); fi
  if [ -n "$base" ]; then
    if [ "$ORCHARD_APP_DOMAIN" = "apps.$base" ]; then APP_DOMAIN_SET=false; fi
    if [ "$INGRESS_MODE" = tunnel ] && [ "$ORCHARD_APP_DOMAIN" = "$base" ]; then APP_DOMAIN_SET=false; fi
    if [ "$ORCHARD_MCP_DOMAIN" = "mcp.$base" ] || [ "$ORCHARD_MCP_DOMAIN" = "mcp.apps.$base" ]; then MCP_DOMAIN_SET=false; fi
  fi
  if [ -n "$old" ] && [ "$ORCHARD_INGRESS_CNAME" = "$old" ]; then CNAME_SET=false; fi
  derive_answers
}

q_domain() {
  local old=$ORCHARD_DOMAIN default answer attempt=0
  q_head "Dashboard domain"
  case "$INGRESS_MODE" in
    public)
      note "Where people open Orchard, such as orchard.example.com."
      default=${ORCHARD_DOMAIN:-$(default_domain)}
      if is_sslip "$default"; then
        note "Press Enter to use $default: sslip.io answers for the IP in the name,"
        note "so you add no DNS records. All sslip.io users share one Let's Encrypt limit, so"
        note "a certificate can be delayed. Use your own domain for anything you keep."
      fi
      ;;
    tunnel)
      note "Where people open Orchard. It must be in a zone on your Cloudflare account."
      default=$ORCHARD_DOMAIN
      ;;
    lan)
      note "How people on your network reach this machine: an address, a machine name, or a"
      note "Tailscale name. Its other addresses and names work as well."
      default=${ORCHARD_DOMAIN:-$(default_domain)}
      while [ "$attempt" -lt 5 ]; do
        attempt=$((attempt + 1))
        answer=$(clean_host "$(ask "      Dashboard" "$default")")
        if [ -n "$answer" ] && valid_lan_host "$answer"; then
          if [ "$answer" != "$default" ]; then DOMAIN_SET=true; fi
          ORCHARD_DOMAIN=$answer
          on_domain_changed "$old"
          return
        fi
        warn "enter an address or a hostname"
      done
      die "no valid hostname; nothing has been installed"
      ;;
  esac
  answer=$(ask_host "      Dashboard" "$default")
  if [ "$answer" != "$(default_domain)" ]; then DOMAIN_SET=true; fi
  ORCHARD_DOMAIN=$answer
  if [ "$answer" != "$old" ]; then on_domain_changed "$old"; fi
}

q_app_domain() {
  local answer
  q_head "Apps domain"
  note "Each app gets a URL under this domain, such as myapp.$ORCHARD_APP_DOMAIN."
  if is_sslip "$ORCHARD_APP_DOMAIN"; then
    note "sslip.io answers for every name under it, so it needs no DNS record."
  elif [ "$INGRESS_MODE" = lan ]; then
    note "It needs a wildcard record your clients can resolve: *.$ORCHARD_APP_DOMAIN."
  else
    note "It needs a wildcard DNS record: *.$ORCHARD_APP_DOMAIN."
  fi
  if [ "$INGRESS_MODE" = tunnel ]; then
    note "Cloudflare's free certificate covers your domain and one level under it, such as"
    note "*.example.com but not *.apps.example.com. A deeper name needs Advanced Certificate"
    note "Manager, and without it HTTPS fails at Cloudflare."
  fi
  answer=$(ask_host "      Apps domain" "$ORCHARD_APP_DOMAIN")
  if [ "$answer" != "$ORCHARD_APP_DOMAIN" ]; then APP_DOMAIN_SET=true; fi
  ORCHARD_APP_DOMAIN=$answer
  if [ "$MCP_DOMAIN_SET" != true ]; then ORCHARD_MCP_DOMAIN=$(default_mcp_domain); fi
}

q_cname() {
  local answer default attempt=0 cleaned
  q_head "Custom domains target"
  note "People who bring their own domain point a CNAME at this name. It must reach this machine."
  case "$INGRESS_MODE" in
    tunnel)
      note "In tunnel mode that is your tunnel's address. Each custom domain also needs a route in the tunnel."
      ;;
    lan)
      note "On a private network this only helps clients that can resolve the name."
      ;;
  esac
  note "Type none to skip: Orchard then can't check custom domains before it requests a certificate."
  default=$ORCHARD_INGRESS_CNAME
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    answer=$(ask "      CNAME target" "$default")
    case "$answer" in
      none|'')
        ORCHARD_INGRESS_CNAME=''
        CNAME_SET=true
        return
        ;;
    esac
    cleaned=$(clean_host "$answer")
    if valid_host "$cleaned"; then
      if [ "$cleaned" != "$default" ]; then CNAME_SET=true; fi
      ORCHARD_INGRESS_CNAME=$cleaned
      return
    fi
    warn "enter a full name, such as edge.example.com, or none"
  done
  die "no valid hostname; nothing has been installed"
}

q_mcp() {
  local default=yes
  if [ "$ORCHARD_MCP" = false ]; then default=no; fi
  q_head "MCP endpoint"
  note "Lets AI agents such as Claude manage this instance through the same API as the dashboard."
  if [ "$(ask_yes_no "      Serve an MCP endpoint so AI agents can connect?" "$default")" = no ]; then
    ORCHARD_MCP=false
    return
  fi
  ORCHARD_MCP=true
  q_mcp_host
}

q_mcp_host() {
  local answer attempt=0
  note "Any name works. Press Enter to use the name shown, or type your own."
  if ! is_sslip "$ORCHARD_APP_DOMAIN"; then
    note "A name directly under *.$ORCHARD_APP_DOMAIN needs no extra DNS record."
  fi
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    answer=$(ask_host "      MCP hostname" "$ORCHARD_MCP_DOMAIN")
    if [ "$answer" != "$ORCHARD_DOMAIN" ]; then break; fi
    warn "the dashboard already uses $answer"
    answer=''
  done
  [ -n "$answer" ] || die "no valid hostname; nothing has been installed"
  if [ "$answer" != "$ORCHARD_MCP_DOMAIN" ]; then MCP_DOMAIN_SET=true; fi
  ORCHARD_MCP_DOMAIN=$answer
  if covered_by_app_wildcard "$ORCHARD_MCP_DOMAIN"; then
    info "No extra DNS record. Orchard reserves this name, so no app can take it."
  elif is_sslip "$ORCHARD_MCP_DOMAIN"; then
    info "No DNS record: sslip.io answers for this name."
  else
    info "This name needs its own DNS record. The DNS step lists it."
  fi
}

q_email() {
  local answer attempt=0 problem
  q_head "Let's Encrypt email"
  note "Optional. Let's Encrypt uses it for notices about your account. Press Enter to skip."
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    answer=$(ask "      Email" "$ORCHARD_ACME_EMAIL")
    if [ "$answer" = none ] || [ -z "$answer" ]; then
      ORCHARD_ACME_EMAIL=''
      return
    fi
    problem=$(email_problem "$answer")
    if [ -z "$problem" ]; then
      ORCHARD_ACME_EMAIL=$answer
      return
    fi
    warn "$problem"
  done
  die "no valid email; nothing has been installed"
}

q_updates() {
  local answer attempt=0
  q_head "Updates"
  note "manual     Run sudo orchardctl update when you choose."
  note "automatic  Install new versions every night. Apps stay up, the dashboard restarts."
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    answer=$(ask "      Updates" "$ORCHARD_UPDATE_POLICY")
    case "$answer" in
      1|m|manual) ORCHARD_UPDATE_POLICY=manual; return ;;
      2|a|auto|automatic) ORCHARD_UPDATE_POLICY=automatic; return ;;
    esac
    warn "answer manual or automatic"
  done
  die "no update policy chosen; nothing has been installed"
}

q_s3() {
  q_head "Off-server storage"
  note "Backups stay on this machine unless you add S3-compatible storage."
  choose_s3_storage
}

q_limits() {
  local answer attempt=0
  q_head "Resource limits"
  note "on    Apps and databases get default CPU and memory caps, so one can't starve the rest."
  note "off   No caps. This fits one person running their own apps."
  note "ask   Choose in the dashboard setup. Either way, you can change it later in the dashboard."
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    answer=$(ask "      Limits" "${ORCHARD_LIMITS:-ask}")
    case "$answer" in
      on|off) ORCHARD_LIMITS=$answer; return ;;
      ask) ORCHARD_LIMITS=''; return ;;
    esac
    warn "answer on, off or ask"
  done
  die "no limits choice made; nothing has been installed"
}

first_pass_questions() {
  local ids='' given_mcp=false
  if [ -z "$INGRESS_MODE" ]; then ids="$ids mode"; fi
  if [ "$INGRESS_MODE" = tunnel ] && [ -z "$ORCHARD_TUNNEL_TOKEN" ]; then ids="$ids tunnel_token"; fi
  if [ "$PUBLIC_IP_SET" != true ]; then ids="$ids public_ip"; fi
  if [ "$DOMAIN_SET" != true ]; then ids="$ids domain"; fi
  if [ "$APP_DOMAIN_SET" != true ]; then ids="$ids app_domain"; fi
  if [ "$CNAME_SET" != true ]; then ids="$ids cname"; fi
  if answer_given --mcp ORCHARD_MCP || [ "$MCP_DOMAIN_SET" = true ]; then given_mcp=true; fi
  if [ "$given_mcp" = false ]; then
    ids="$ids mcp"
  elif [ "$ORCHARD_MCP" = true ] && [ "$MCP_DOMAIN_SET" != true ]; then
    ids="$ids mcp_host"
  fi
  if [ "$INGRESS_MODE" != lan ] && [ "$INGRESS_MODE" != tunnel ] && ! answer_given --email ORCHARD_ACME_EMAIL; then
    ids="$ids email"
  fi
  if ! answer_given --updates ORCHARD_UPDATE_POLICY; then ids="$ids updates"; fi
  if [ "$ORCHARD_S3" != false ] && [ -z "$ORCHARD_S3_ENDPOINT$ORCHARD_S3_BUCKET$ORCHARD_S3_ACCESS_KEY" ]; then
    ids="$ids s3"
  fi
  printf '%s' "$ids"
}

review_ids() {
  printf 'mode'
  if [ "$INGRESS_MODE" = tunnel ]; then printf ' tunnel_token'; fi
  printf ' public_ip domain app_domain cname mcp'
  if [ "$INGRESS_MODE" = public ]; then printf ' email'; fi
  printf ' updates s3 limits'
}

review_label() {
  case "$1" in
    mode) printf 'Traffic' ;;
    tunnel_token) printf 'Tunnel token' ;;
    public_ip) printf 'Public IP' ;;
    domain) printf 'Dashboard' ;;
    app_domain) printf 'Apps' ;;
    cname) printf 'Custom domains' ;;
    mcp) printf 'MCP endpoint' ;;
    email) printf "Let's Encrypt email" ;;
    updates) printf 'Updates' ;;
    s3) printf 'S3 storage' ;;
    limits) printf 'Resource limits' ;;
  esac
}

public_scheme() {
  if [ "$INGRESS_MODE" = lan ]; then printf 'http://%s' "$1$HTTP_SUFFIX"; else printf 'https://%s' "$1"; fi
}

review_value() {
  case "$1" in
    mode) printf '%s' "$INGRESS_MODE" ;;
    tunnel_token)
      if [ -n "$(tunnel_id)" ]; then printf 'set, tunnel %s' "$(tunnel_id)"; else printf 'set'; fi
      ;;
    public_ip)
      if [ -n "$ORCHARD_PUBLIC_IP" ]; then
        printf '%s' "$ORCHARD_PUBLIC_IP"
      else
        printf 'not set, public ports and databases are unavailable'
      fi
      ;;
    domain) public_scheme "$ORCHARD_DOMAIN" ;;
    app_domain) printf '*.%s' "$ORCHARD_APP_DOMAIN" ;;
    cname)
      if [ -n "$ORCHARD_INGRESS_CNAME" ]; then
        printf 'CNAME to %s' "$ORCHARD_INGRESS_CNAME"
      else
        printf 'not set, custom domains are not checked'
      fi
      ;;
    mcp)
      if [ "$ORCHARD_MCP" = true ]; then
        public_scheme "$ORCHARD_MCP_DOMAIN"
      else
        printf 'off'
      fi
      ;;
    email)
      if [ -n "$ORCHARD_ACME_EMAIL" ]; then printf '%s' "$ORCHARD_ACME_EMAIL"; else printf 'none'; fi
      ;;
    updates) printf '%s' "$ORCHARD_UPDATE_POLICY" ;;
    s3)
      if [ "$S3_READY" = true ]; then
        printf '%s at %s' "$ORCHARD_S3_BUCKET" "$ORCHARD_S3_ENDPOINT"
      elif [ "$PREVIOUS_INSTALL" = true ]; then
        printf 'no change'
      else
        printf 'none, backups stay on this machine'
      fi
      ;;
    limits)
      if [ -n "$ORCHARD_LIMITS" ]; then
        printf '%s' "$ORCHARD_LIMITS"
      elif [ "$PREVIOUS_INSTALL" = true ]; then
        printf 'no change'
      else
        printf 'choose in the dashboard setup'
      fi
      ;;
  esac
}

show_review() {
  local n=0 id
  printf '\n  %sReview%s\n\n' "$C_BOLD" "$C_RESET"
  for id in $(review_ids); do
    n=$((n + 1))
    printf '  %s%3d%s  %-20s %s\n' "$C_GREY" "$n" "$C_RESET" "$(review_label "$id")" "$(review_value "$id")"
  done
  printf '\n'
}

describe_changes() {
  [ "$PREVIOUS_INSTALL" = true ] || return 0
  local any=false
  change_line() {
    if [ "$any" = false ]; then
      printf '  %sWhat changes on this machine%s\n' "$C_BOLD" "$C_RESET"
      any=true
    fi
    note "$@"
  }
  if [ "$INGRESS_MODE" != "$PREV_MODE" ] && [ -n "$PREV_MODE" ]; then
    change_line "Traffic moves from $PREV_MODE to $INGRESS_MODE. Your DNS records have to change with it."
  fi
  if [ "$ORCHARD_DOMAIN" != "$PREV_DOMAIN" ] && [ -n "$PREV_DOMAIN" ]; then
    change_line "Dashboard moves from $PREV_DOMAIN to $ORCHARD_DOMAIN. Everyone signs in again."
    change_line "  Passkeys belong to the old name and stop working. Use a password or 'sudo orchardctl login'."
    change_line "  The GitHub App and any SSO provider keep the old URL until you update them."
  fi
  if [ "$ORCHARD_APP_DOMAIN" != "$PREV_APP_DOMAIN" ] && [ -n "$PREV_APP_DOMAIN" ]; then
    change_line "Apps domain moves from $PREV_APP_DOMAIN to $ORCHARD_APP_DOMAIN. Only new apps use it."
    change_line "  Deployed apps keep their URLs, also after a redeploy, while DNS for the old name points here."
    change_line "  To move an app, add a domain to it."
  fi
  if [ "$ORCHARD_MCP" != "$PREV_MCP" ] && [ -n "$PREV_MCP" ]; then
    if [ "$ORCHARD_MCP" = true ]; then
      change_line "The MCP endpoint turns on."
    else
      change_line "The MCP endpoint turns off. Connected agents stop working."
    fi
  fi
  if [ "$ORCHARD_MCP" = true ] && [ "$PREV_MCP" = true ] && [ "$ORCHARD_MCP_DOMAIN" != "$PREV_MCP_DOMAIN" ] && [ -n "$PREV_MCP_DOMAIN" ]; then
    change_line "MCP moves from $PREV_MCP_DOMAIN to $ORCHARD_MCP_DOMAIN. Reconnect every agent at the new URL."
  fi
  if [ "$ORCHARD_INGRESS_CNAME" != "$PREV_CNAME" ]; then
    change_line "Custom domains target is now ${ORCHARD_INGRESS_CNAME:-not set}. Domains already added keep working"
    change_line "  while their CNAME still reaches this machine. New ones are checked against the new target."
  fi
  if [ "$ORCHARD_PUBLIC_IP" != "$PREV_PUBLIC_IP" ]; then
    change_line "Public IP is now ${ORCHARD_PUBLIC_IP:-not set}. Ports and databases already published stay on the"
    change_line "  old address until you turn public access off and on again."
  fi
  if [ "$ORCHARD_ACME_EMAIL" != "$PREV_EMAIL" ] && [ "$INGRESS_MODE" = public ]; then
    change_line "Let's Encrypt email is now ${ORCHARD_ACME_EMAIL:-none}. Certificates are not affected."
  fi
  if [ "$ORCHARD_UPDATE_POLICY" != "$PREV_UPDATES" ] && [ -n "$PREV_UPDATES" ]; then
    change_line "Updates change to $ORCHARD_UPDATE_POLICY."
  fi
  if [ "$any" = true ]; then printf '\n'; fi
  unset -f change_line
}

edit_answer() {
  Q_TOTAL=0
  Q_N=0
  case "$1" in
    mode) q_mode ;;
    tunnel_token) q_tunnel_token ;;
    public_ip) q_public_ip ;;
    domain) q_domain ;;
    app_domain) q_app_domain ;;
    cname) q_cname ;;
    mcp) q_mcp ;;
    email) q_email ;;
    updates) q_updates ;;
    s3)
      ORCHARD_S3=''
      S3_READY=false
      ORCHARD_S3_ENDPOINT='' ORCHARD_S3_BUCKET='' ORCHARD_S3_ACCESS_KEY='' ORCHARD_S3_SECRET_KEY='' ORCHARD_S3_SECRET_KEY_FILE=''
      q_s3
      ;;
    limits) q_limits ;;
  esac
}

review_answers() {
  local choice id n ids ASK_SOFT=false
  while true; do
    show_review
    describe_changes
    if [ "$PREVIOUS_INSTALL" = true ]; then
      note "Enter applies these. A number changes that answer. c cancels and changes nothing."
    else
      note "Enter installs. A number changes that answer. c cancels: nothing has been installed."
    fi
    choice=$(ask "      Choice")
    case "$choice" in
      '') return 0 ;;
      c|C|cancel)
        printf '\n'
        if [ "$PREVIOUS_INSTALL" = true ]; then
          note "Canceled. Nothing was changed."
        else
          note "Canceled. Nothing was installed."
        fi
        exit 0
        ;;
      *[!0-9]*)
        warn "press Enter, type a number, or type c"
        continue
        ;;
    esac
    ids=$(review_ids)
    n=0
    id=''
    local candidate
    for candidate in $ids; do
      n=$((n + 1))
      if [ "$n" = "$choice" ]; then id=$candidate; fi
    done
    if [ -z "$id" ]; then
      warn "no answer has that number"
      continue
    fi
    edit_answer "$id"
    validate_answers
    apply_mode_settings
  done
}

probe_given_s3() {
  if [ "$ORCHARD_S3" != false ] && [ -n "$ORCHARD_S3_ENDPOINT$ORCHARD_S3_BUCKET$ORCHARD_S3_ACCESS_KEY" ]; then
    choose_s3_storage
  fi
}

collect_answers() {
  step

  if [ -n "$ORCHARD_INGRESS_MODE" ]; then
    INGRESS_MODE=$ORCHARD_INGRESS_MODE
  elif [ "$ASSUME_YES" = true ] || [ "$PREVIOUS_INSTALL" = true ]; then
    INGRESS_MODE=$(recommended_mode)
    info "mode: $INGRESS_MODE. $(recommended_reason)"
  else
    INGRESS_MODE=''
  fi
  if [ -n "$INGRESS_MODE" ]; then check_mode_constraints; fi

  mark_given_answers
  if [ "$PREVIOUS_INSTALL" = true ]; then
    PUBLIC_IP_SET=true
    CNAME_SET=true
    if [ "$MOVING_OFF_SSLIP" = true ]; then
      CNAME_SET=false
      if answer_given --ingress-cname ORCHARD_INGRESS_CNAME; then CNAME_SET=true; fi
    fi
  fi
  if [ -z "$ORCHARD_UPDATE_POLICY" ]; then choose_update_policy; fi

  if [ "$ASSUME_YES" = true ]; then
    derive_answers
    validate_answers
    apply_mode_settings
    if [ "$PREVIOUS_INSTALL" = true ]; then describe_changes; fi
    choose_s3_storage
    local id
    for id in $(review_ids); do
      info "$(review_label "$id"): $(review_value "$id")"
    done
    return 0
  fi

  if [ -n "$INGRESS_MODE" ]; then derive_answers; fi

  if [ "$PREVIOUS_INSTALL" = true ]; then
    printf '\n'
    note "Orchard is already installed here. These are its current settings."
    note "Change what you need. Anything you leave alone stays as it is."
    probe_given_s3
    validate_answers
    apply_mode_settings
    review_answers
    return 0
  fi

  local questions question extra
  FIRST_PASS=true
  questions=$(first_pass_questions)
  Q_N=0
  Q_TOTAL=0
  for question in $questions; do Q_TOTAL=$((Q_TOTAL + 1)); done
  if [ "$Q_TOTAL" -gt 0 ]; then
    printf '\n'
    note "A few questions. Press Enter to accept the value in brackets."
    note "Nothing is installed until you confirm your answers on the review screen."
  fi
  for question in $questions; do
    if [ "$question" != mode ] && [ -z "$INGRESS_MODE" ]; then die "no mode chosen; nothing has been installed"; fi
    case "$question" in
      tunnel_token) if [ "$INGRESS_MODE" = tunnel ] && [ -z "$ORCHARD_TUNNEL_TOKEN" ]; then q_tunnel_token; fi ;;
      email) if [ "$INGRESS_MODE" = public ]; then q_email; fi ;;
      domain) if [ "$DOMAIN_SET" != true ]; then q_domain; fi ;;
      mcp_host) q_mcp_host ;;
      mode)
        q_mode
        Q_TOTAL=1
        for extra in $(first_pass_questions); do Q_TOTAL=$((Q_TOTAL + 1)); done
        if [ "$INGRESS_MODE" = tunnel ] && [ -z "$ORCHARD_TUNNEL_TOKEN" ]; then q_tunnel_token; fi
        ;;
      *) "q_$question" ;;
    esac
  done
  FIRST_PASS=false
  probe_given_s3
  validate_answers
  apply_mode_settings
  review_answers
}

DNS_PROBE_LABEL=orchard-dns-probe
PUBLIC_RESOLVERS=${ORCHARD_DNS_RESOLVERS:-1.1.1.1 8.8.8.8 2606:4700:4700::1111}
RECORD_TYPES=()
RECORD_NAMES=()
RECORD_VALUES=()
RECORD_PROBES=()
DNS_PENDING=''
DNS_SKIPPED=false
CHECK_STATUS=''
CHECK_NOTE=''
PROXY_NOTE_SHOWN=false

dns_type_number() {
  case "$1" in
    A) printf 1 ;;
    NS) printf 2 ;;
    CNAME) printf 5 ;;
    AAAA) printf 28 ;;
    CAA) printf 257 ;;
  esac
}

dns_ask_public() {
  local type=$1 name=$2 resolver out rc url
  if command -v dig >/dev/null 2>&1; then
    for resolver in $PUBLIC_RESOLVERS; do
      rc=0
      out=$(dig "@$resolver" +time=2 +tries=1 +noall +answer "$type" "$name" 2>/dev/null) || rc=$?
      if [ "$rc" -eq 0 ]; then
        printf '%s\n' "$out" | awk -v t="$type" '$4 == t { $1=$2=$3=$4=""; sub(/^ +/, ""); print }' | sed 's/\.$//' || true
        return 0
      fi
    done
  fi
  for url in https://cloudflare-dns.com/dns-query https://dns.google/resolve; do
    out=$(curl -fsS --max-time 4 -H 'accept: application/dns-json' "$url?name=$name&type=$type" 2>/dev/null) || continue
    case "$out" in *'"Status"'*) ;; *) continue ;; esac
    printf '%s' "$out" | tr '{' '\n' | grep "\"type\":$(dns_type_number "$type")[,}]" \
      | sed -n 's/.*"data":"\([^"]*\)".*/\1/p' | sed 's/\.$//' || true
    return 0
  done
  return 1
}

dns_ask_local() {
  local name=$1 line
  if command -v getent >/dev/null 2>&1; then
    if command -v timeout >/dev/null 2>&1; then
      timeout 5 getent ahosts "$name" 2>/dev/null | awk '{print $1}' | sort -u || true
    else
      getent ahosts "$name" 2>/dev/null | awk '{print $1}' | sort -u || true
    fi
    return 0
  fi
  if command -v dig >/dev/null 2>&1; then
    { dig +short +time=2 +tries=1 A "$name" 2>/dev/null; dig +short +time=2 +tries=1 AAAA "$name" 2>/dev/null; } | while IFS= read -r line; do
      if is_ip "$line"; then printf '%s\n' "$line"; fi
    done || true
  fi
  return 0
}

dns_zone_of() {
  local name=$1 out
  while true; do
    case "$name" in *.*) ;; *) return 1 ;; esac
    out=$(dns_ask_public NS "$name") || return 2
    if [ -n "$out" ]; then
      printf '%s\n%s\n' "$name" "$out"
      return 0
    fi
    name=${name#*.}
  done
}

is_public_suffix_like() {
  case "$1" in
    co.??|com.??|org.??|net.??|ac.??|gov.??|edu.??) return 0 ;;
    *.*) return 1 ;;
    *) return 0 ;;
  esac
}

dns_delegated_from() {
  local parent=${1#*.} out
  if is_public_suffix_like "$parent"; then return 0; fi
  while true; do
    out=$(dns_ask_public NS "$parent") || return 0
    if [ -n "$out" ]; then
      printf '%s' "$parent"
      return 0
    fi
    parent=${parent#*.}
    if is_public_suffix_like "$parent"; then return 0; fi
  done
}

dns_zone_report() {
  local i=0 name seen=' ' rc output zone servers parent
  while [ "$i" -lt "${#RECORD_NAMES[@]}" ]; do
    name=${RECORD_NAMES[$i]#\*.}
    i=$((i + 1))
    rc=0
    output=$(dns_zone_of "$name") || rc=$?
    case "$rc" in
      1)
        note "No nameservers answer for $name. Check that the domain is registered and its"
        note "nameservers are set at your registrar."
        continue
        ;;
      2) continue ;;
    esac
    zone=$(printf '%s\n' "$output" | head -1)
    case "$seen" in *" $zone "*) continue ;; esac
    seen="$seen$zone "
    servers=$(printf '%s\n' "$output" | tail -n +2 | tr '\n' ' ')
    note "Create these in the DNS panel for $zone. Its nameservers: ${servers% }"
    parent=$(dns_delegated_from "$zone")
    if [ -n "$parent" ]; then
      note "$zone is delegated away from $parent, so records added at $parent's provider do nothing."
    fi
  done
}

tunnel_tls_refused() {
  local host=$1 attempt=0 rc
  while [ "$attempt" -lt 3 ]; do
    rc=0
    curl -sS -o /dev/null --max-time 10 "https://$host/" 2>/dev/null || rc=$?
    [ "$rc" -eq 35 ] || return 1
    attempt=$((attempt + 1))
    sleep 3
  done
  return 0
}

tunnel_tls_failures() {
  local host out=''
  for host in "$ORCHARD_DOMAIN" "$DNS_PROBE_LABEL.$ORCHARD_APP_DOMAIN"; do
    if tunnel_tls_refused "$host"; then out="$out$host "; fi
  done
  if [ "$ORCHARD_MCP" = true ] && tunnel_tls_refused "$ORCHARD_MCP_DOMAIN"; then
    out="$out$ORCHARD_MCP_DOMAIN "
  fi
  printf '%s' "${out% }"
}

tunnel_names_too_deep() {
  local i=0 name zone label
  while [ "$i" -lt "${#RECORD_NAMES[@]}" ]; do
    name=${RECORD_NAMES[$i]}
    i=$((i + 1))
    zone=$(dns_zone_of "${name#\*.}" 2>/dev/null | head -1 || true)
    [ -n "$zone" ] && [ "$name" != "$zone" ] || continue
    label=${name%".$zone"}
    case "$label" in
      "$name") ;;
      *.*) printf '%s %s\n' "$name" "$zone" ;;
    esac
  done
}

dns_tunnel_cert_report() {
  [ "$INGRESS_MODE" = tunnel ] || return 0
  local name zone deep
  deep=$(tunnel_names_too_deep)
  [ -n "$deep" ] || return 0
  warn "Cloudflare's free certificate won't cover these names, so HTTPS fails with a handshake error:"
  while read -r name zone; do
    note "$name is more than one level under $zone."
  done <<EOF
$deep
EOF
  note "Use names directly under the zone, or add Advanced Certificate Manager in Cloudflare."
}

dns_caa_report() {
  [ "$INGRESS_MODE" = public ] || return 0
  local i=0 name current zone caa warned=' '
  while [ "$i" -lt "${#RECORD_NAMES[@]}" ]; do
    name=${RECORD_NAMES[$i]#\*.}
    i=$((i + 1))
    zone=$(dns_zone_of "$name" 2>/dev/null | head -1 || true)
    current=$name
    while [ -n "$current" ]; do
      caa=$(dns_ask_public CAA "$current" || true)
      if [ -n "$caa" ]; then
        case "$caa" in
          *issue*letsencrypt*) ;;
          *issue*)
            case "$warned" in
              *" $current "*) ;;
              *)
                warned="$warned$current "
                warn "$current has CAA records that don't allow Let's Encrypt. Add: 0 issue \"letsencrypt.org\""
                ;;
            esac
            ;;
        esac
        break
      fi
      if [ "$current" = "$zone" ] || [ "$current" = "${current#*.}" ]; then break; fi
      current=${current#*.}
    done
  done
}

add_record() {
  local n=${#RECORD_TYPES[@]}
  RECORD_TYPES[$n]=$1
  RECORD_NAMES[$n]=$2
  RECORD_VALUES[$n]=$3
  RECORD_PROBES[$n]=$4
}

build_dns_records() {
  RECORD_TYPES=()
  RECORD_NAMES=()
  RECORD_VALUES=()
  RECORD_PROBES=()
  [ "$INGRESS_MODE" != lan ] || return 0

  local type=A value=$ORCHARD_PUBLIC_IP
  if [ "$INGRESS_MODE" = tunnel ]; then
    type=CNAME
    value="$(tunnel_id)"
    if [ -n "$value" ]; then value="$value.cfargotunnel.com"; else value='<tunnel-id>.cfargotunnel.com'; fi
  elif is_ipv6 "$value"; then
    type=AAAA
  fi

  if ! is_sslip "$ORCHARD_DOMAIN"; then
    add_record "$type" "$ORCHARD_DOMAIN" "$value" "$ORCHARD_DOMAIN"
  fi
  if ! is_sslip "$ORCHARD_APP_DOMAIN"; then
    add_record "$type" "*.$ORCHARD_APP_DOMAIN" "$value" "$DNS_PROBE_LABEL.$ORCHARD_APP_DOMAIN"
  fi
  if [ "$ORCHARD_MCP" = true ] && ! is_sslip "$ORCHARD_MCP_DOMAIN" && ! covered_by_app_wildcard "$ORCHARD_MCP_DOMAIN"; then
    add_record "$type" "$ORCHARD_MCP_DOMAIN" "$value" "$ORCHARD_MCP_DOMAIN"
  fi
  if [ -n "$ORCHARD_INGRESS_CNAME" ] && [ "$ORCHARD_INGRESS_CNAME" != "$ORCHARD_DOMAIN" ] \
    && [ "$ORCHARD_INGRESS_CNAME" != "$ORCHARD_MCP_DOMAIN" ] \
    && ! is_sslip "$ORCHARD_INGRESS_CNAME" && ! covered_by_app_wildcard "$ORCHARD_INGRESS_CNAME"; then
    case "$ORCHARD_INGRESS_CNAME" in
      *.cfargotunnel.com) ;;
      *) add_record "$type" "$ORCHARD_INGRESS_CNAME" "$value" "$ORCHARD_INGRESS_CNAME" ;;
    esac
  fi
}

print_dns_records() {
  local i=0 width=4 display
  while [ "$i" -lt "${#RECORD_NAMES[@]}" ]; do
    if [ "${#RECORD_NAMES[$i]}" -gt "$width" ]; then width=${#RECORD_NAMES[$i]}; fi
    i=$((i + 1))
  done
  printf '\n      %-6s %-*s  %s\n' Type "$width" Name Value
  i=0
  while [ "$i" -lt "${#RECORD_NAMES[@]}" ]; do
    display=${RECORD_VALUES[$i]:-<your public IP>}
    printf '      %-6s %-*s  %s\n' "${RECORD_TYPES[$i]}" "$width" "${RECORD_NAMES[$i]}" "$display"
    i=$((i + 1))
  done
  printf '\n'
}

note_lines() {
  local line
  [ -n "$1" ] || return 0
  while IFS= read -r line; do
    [ -z "$line" ] || note "       $line"
  done <<EOF
$(printf '%s\n' "$1" | fold -s -w 76)
EOF
}

all_cloudflare() {
  local answer
  [ -n "$1" ] || return 1
  for answer in $1; do
    if ! is_cloudflare_ip "$answer"; then return 1; fi
  done
  return 0
}

all_private() {
  local answer
  [ -n "$1" ] || return 1
  for answer in $1; do
    if ! is_private_ip "$answer"; then return 1; fi
  done
  return 0
}

one_line() {
  printf '%s' "$1" | tr '\n' ' ' | sed 's/ *$//'
}

check_tunnel_record() {
  local probe=$1 value=$2 answers cnames rc=0
  answers=$(dns_ask_public A "$probe") || rc=$?
  if [ "$rc" -ne 0 ]; then CHECK_STATUS='not checked'; return 0; fi
  cnames=$(dns_ask_public CNAME "$probe" || true)
  case "$cnames" in
    *"$value"*) CHECK_STATUS=resolves; return 0 ;;
  esac
  if [ -z "$answers$cnames" ]; then
    CHECK_STATUS=waiting
    return 0
  fi
  if all_cloudflare "$answers"; then
    CHECK_STATUS=resolves
    CHECK_NOTE="Cloudflare hides the target of a proxied record, so check the route in the tunnel."
    return 0
  fi
  CHECK_STATUS='wrong value'
  CHECK_NOTE="It answers $(one_line "${answers:-$cnames}"), not Cloudflare. Tunnel traffic only arrives through a proxied CNAME to $value."
}

check_address_record() {
  local type=$1 name=$2 value=$3 probe=$4 answers local_answers rc=0 other_type=AAAA other zone
  answers=$(dns_ask_public "$type" "$probe") || rc=$?
  if [ "$rc" -ne 0 ]; then
    CHECK_STATUS='not checked'
    CHECK_NOTE="No public resolver could be reached from this machine, so this was not checked."
    return 0
  fi
  local_answers=$(dns_ask_local "$probe")

  if [ -z "$answers" ]; then
    if [ "$type" = AAAA ]; then other_type=A; fi
    other=$(dns_ask_public "$other_type" "$probe" || true)
    if [ -n "$other" ]; then
      CHECK_STATUS='wrong value'
      CHECK_NOTE="It has an $other_type record ($(one_line "$other")), and this machine needs an $type record."
      return 0
    fi
    CHECK_STATUS=waiting
    if [ -n "$local_answers" ]; then
      CHECK_NOTE="This machine resolves it to $(one_line "$local_answers"), but public DNS has no answer.
That is split-horizon DNS, or an entry in /etc/hosts. Let's Encrypt only sees public DNS."
    fi
    return 0
  fi

  if [ -z "$value" ]; then
    CHECK_STATUS=resolves
    return 0
  fi

  case " $(one_line "$answers") " in
    *" $value "*)
      CHECK_STATUS=resolves
      if [ "$(one_line "$answers")" != "$value" ]; then
        CHECK_NOTE="It also answers with other addresses: $(one_line "$answers"). Some visitors and Let's Encrypt may land on those, so remove them."
      fi
      if [ -n "$local_answers" ]; then
        case " $(one_line "$local_answers") " in
          *" $value "*) ;;
          *)
            CHECK_NOTE="${CHECK_NOTE:+$CHECK_NOTE
}This machine still resolves it to $(one_line "$local_answers"). That is a cached answer or split-horizon DNS. Let's Encrypt uses public DNS, which is right."
            ;;
        esac
      fi
      return 0
      ;;
  esac

  if all_cloudflare "$answers"; then
    CHECK_STATUS=proxied
    if [ "$PROXY_NOTE_SHOWN" = false ]; then
      PROXY_NOTE_SHOWN=true
      CHECK_NOTE="It answers a Cloudflare address ($(one_line "$answers")), not $value. That is the proxy, the orange cloud.
Let's Encrypt HTTP-01 can still pass through the proxy if Always Use HTTPS is off, and SSL mode must be Full (strict).
Raw ports and databases do not pass through it, and Cloudflare's free certificate does not cover *.apps names.
The simplest fix is DNS only, the grey cloud."
    fi
    return 0
  fi

  CHECK_STATUS='wrong value'
  if all_private "$answers"; then
    CHECK_NOTE="It answers $(one_line "$answers"), a private address nothing on the internet can reach.
Point it at $value. If this machine is only for a private network, choose lan mode."
    return 0
  fi

  CHECK_NOTE="It points at $(one_line "$answers"), not $value. Change the record. A changed record can take as long as its old TTL."
  zone=$(dns_zone_of "${name#\*.}" 2>/dev/null | head -1 || true)
  if [ "$zone" = "$name" ]; then
    CHECK_NOTE="$CHECK_NOTE
$name is the top of its zone, and that address is probably a website. Pointing it here moves that site. To keep the site, change the dashboard to a subdomain such as orchard.$name."
  fi
}

check_record() {
  local i=$1
  CHECK_STATUS=waiting
  CHECK_NOTE=''
  if [ "${RECORD_TYPES[$i]}" = CNAME ]; then
    check_tunnel_record "${RECORD_PROBES[$i]}" "${RECORD_VALUES[$i]}"
  else
    check_address_record "${RECORD_TYPES[$i]}" "${RECORD_NAMES[$i]}" "${RECORD_VALUES[$i]}" "${RECORD_PROBES[$i]}"
  fi
}

status_colour() {
  case "$1" in
    resolves) printf '%s' "$C_OK" ;;
    'wrong value') printf '%s' "$C_FAIL" ;;
    *) printf '%s' "$C_AMBER" ;;
  esac
}

dns_check_all() {
  local i=0 quiet=${1:-false} wildcard_waiting=false
  DNS_PENDING=''
  PROXY_NOTE_SHOWN=false
  while [ "$i" -lt "${#RECORD_NAMES[@]}" ]; do
    check_record "$i"
    if [ "$quiet" != true ]; then
      printf '      %s%-12s%s %s\n' "$(status_colour "$CHECK_STATUS")" "$CHECK_STATUS" "$C_RESET" "${RECORD_NAMES[$i]}"
      note_lines "$CHECK_NOTE"
    fi
    if [ "$CHECK_STATUS" != resolves ]; then
      DNS_PENDING="$DNS_PENDING${RECORD_NAMES[$i]} ($CHECK_STATUS)
"
      case "${RECORD_NAMES[$i]}" in
        \**) if [ "$CHECK_STATUS" = waiting ]; then wildcard_waiting=true; fi ;;
      esac
    fi
    i=$((i + 1))
  done
  if [ "$quiet" != true ] && [ "$wildcard_waiting" = true ]; then
    printf '\n'
    note "If your DNS provider doesn't allow wildcard records, add one record for each app as you"
    note "deploy it, or move this domain to a provider that does. The dashboard works either way."
  fi
}

port_state() {
  local rc=0
  command -v timeout >/dev/null 2>&1 || { printf unknown; return 0; }
  timeout 4 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2" 2>/dev/null || rc=$?
  case "$rc" in
    0) printf open ;;
    124) printf blocked ;;
    *) printf refused ;;
  esac
}

check_reachability() {
  [ "$INGRESS_MODE" = public ] || return 0
  [ -n "$ORCHARD_PUBLIC_IP" ] || return 0
  if is_private_ip "$ORCHARD_PUBLIC_IP"; then return 0; fi
  if ip_is_local "$ORCHARD_PUBLIC_IP"; then
    note "$ORCHARD_PUBLIC_IP is on this machine, so a test from here can't check the firewall. If 80 and 443"
    note "are blocked upstream, the summary reports it when the certificate fails."
    note "$(firewall_hint)"
    return 0
  fi
  local port state blocked=''
  for port in 80 443; do
    state=$(port_state "$ORCHARD_PUBLIC_IP" "$port")
    if [ "$state" = unknown ]; then return 0; fi
    if [ "$state" = blocked ]; then blocked="${blocked:+$blocked and }$port"; fi
  done
  if [ -n "$blocked" ]; then
    warn "Nothing answered on $ORCHARD_PUBLIC_IP port $blocked from this machine. A firewall may be in the way."
    note "DNS can be right and Let's Encrypt still fail. $(firewall_hint)"
    note "Some routers can't loop back to their own address, so this warning can be wrong on a home network."
  else
    info "Connections to $ORCHARD_PUBLIC_IP on 80 and 443 get through from this machine."
  fi
}

print_tunnel_instructions() {
  bold "In Cloudflare, add these to your tunnel"
  note "Go to Zero Trust > Networks > Tunnels > your tunnel > Public Hostname. For each name, set"
  note "the service to http://traefik.traefik.svc.cluster.local:80."
  print_dns_records
  note "Cloudflare creates the CNAME for each hostname, except a wildcard. Add the wildcard by hand"
  note "under DNS > Records, as a proxied CNAME to the value above."
  if [ -z "$(tunnel_id)" ]; then
    note "Your tunnel ID is on the tunnel's page in Zero Trust."
  fi
}

print_lan_instructions() {
  note "LAN mode needs no public DNS. People reach this machine at $(public_scheme "$ORCHARD_DOMAIN")."
  note "Tailscale: MagicDNS gives the machine a name such as box.tailnet.ts.net. It has no wildcards,"
  note "so generated app URLs stay on sslip.io, and sslip.io needs internet DNS on each client."
  note ".local names come from mDNS. They cover this machine only, and no subdomains."
  note "To add another name later: sudo orchardctl hostname add <name> --apply"
}

dns_settings_unchanged() {
  [ "$PREVIOUS_INSTALL" = true ] || return 1
  [ "$ORCHARD_DOMAIN" = "$PREV_DOMAIN" ] || return 1
  [ "$ORCHARD_APP_DOMAIN" = "$PREV_APP_DOMAIN" ] || return 1
  [ "$INGRESS_MODE" = "$PREV_MODE" ] || return 1
  [ "$ORCHARD_MCP" = "$PREV_MCP" ] || return 1
  [ "$ORCHARD_MCP" = false ] || [ "$ORCHARD_MCP_DOMAIN" = "$PREV_MCP_DOMAIN" ] || return 1
  [ "$ORCHARD_INGRESS_CNAME" = "$PREV_CNAME" ] || return 1
}

dns_step() {
  step
  build_dns_records

  if [ "$INGRESS_MODE" = lan ]; then
    print_lan_instructions
    return 0
  fi

  if dns_settings_unchanged; then
    info "DNS answers haven't changed, so the records aren't listed again."
    dns_check_all true
    if [ -n "$DNS_PENDING" ]; then
      warn "These records still don't point here: $(one_line "$DNS_PENDING")"
    fi
    return 0
  fi

  if [ "${#RECORD_NAMES[@]}" -eq 0 ]; then
    note "sslip.io answers for these names, so there are no DNS records to add."
    note "All sslip.io users share one Let's Encrypt limit, so a certificate can be delayed."
    note "Use your own domain for anything you keep."
    check_reachability
    return 0
  fi

  if [ "$INGRESS_MODE" = tunnel ]; then
    print_tunnel_instructions
  else
    bold "Create these DNS records"
    print_dns_records
    if is_ipv6 "$ORCHARD_PUBLIC_IP"; then
      warn "These are AAAA records because $ORCHARD_PUBLIC_IP is an IPv6 address, and Orchard listens on IPv4 only."
      note "They reach Orchard only through a proxy that you run in front of it. Orchard hasn't tested this."
    elif [ -n "$PUBLIC_IP6" ]; then
      note "This machine also has $PUBLIC_IP6. Don't add AAAA records: this install listens on IPv4 only."
    fi
    if [ -z "$ORCHARD_PUBLIC_IP" ]; then
      note "You left the public IP blank, so the check below only looks for an answer."
    fi
  fi
  dns_zone_report
  dns_tunnel_cert_report
  dns_caa_report

  local PROMPT_TIMEOUT=0 ASK_SOFT=true choice
  while true; do
    printf '\n'
    bold "Checking public DNS"
    dns_check_all
    if [ -z "$DNS_PENDING" ]; then
      check_reachability
      return 0
    fi
    if [ "$ASSUME_YES" = true ]; then
      check_reachability
      info "--yes doesn't wait for DNS. Certificates retry on their own."
      return 0
    fi
    printf '\n'
    note "1) Check again. New records usually appear in a few minutes."
    note "2) Continue anyway. Orchard installs now, and the dashboard opens once DNS is right."
    note "3) Skip DNS for now. Until these records exist, the dashboard, the first sign-in link"
    note "   and certificates don't work. Certificates retry on their own once DNS is right."
    note "4) Change an answer."
    choice=$(ask "      Choice" 1)
    case "$choice" in
      1) ;;
      2|__eof__)
        check_reachability
        return 0
        ;;
      3)
        DNS_SKIPPED=true
        return 0
        ;;
      4)
        review_answers
        build_dns_records
        if [ "${#RECORD_NAMES[@]}" -eq 0 ]; then
          DNS_PENDING=''
          return 0
        fi
        printf '\n'
        if [ "$INGRESS_MODE" = tunnel ]; then
          print_tunnel_instructions
        else
          bold "Create these DNS records"
          print_dns_records
        fi
        ;;
      *) warn "pick 1, 2, 3 or 4" ;;
    esac
  done
}

choose_update_policy() {
  if [ -z "$ORCHARD_UPDATE_POLICY" ]; then
    ORCHARD_UPDATE_POLICY=manual
    if [ "$PREVIOUS_INSTALL" = true ] && systemctl is-enabled --quiet orchard-update.timer 2>/dev/null; then
      ORCHARD_UPDATE_POLICY=automatic
    fi
  fi
  case "$ORCHARD_UPDATE_POLICY" in
    manual|automatic) ;;
    *) die "--updates takes manual or automatic, not: $ORCHARD_UPDATE_POLICY" ;;
  esac
}

curl_can_sign() {
  local version major minor
  version=$(curl --version 2>/dev/null | head -1 | cut -d' ' -f2)
  major=${version%%.*}
  minor=${version#*.}
  minor=${minor%%.*}
  [ "${major:-0}" -gt 7 ] || { [ "${major:-0}" -eq 7 ] && [ "${minor:-0}" -ge 75 ]; }
}

s3_request() {
  local method=$1 url=$2 code rc=0
  code=$(printf 'user = "%s:%s"\n' "$ORCHARD_S3_ACCESS_KEY" "$ORCHARD_S3_SECRET_KEY" | curl -sS -K - \
    --max-time 10 -o /dev/null -w '%{http_code}' -X "$method" \
    --aws-sigv4 "aws:amz:${ORCHARD_S3_REGION:-auto}:s3" \
    -H 'x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' \
    -H 'Content-Length: 0' "$url" 2>/dev/null) || rc=$?
  if [ "$rc" -ne 0 ]; then S3_LAST_CODE=000; else S3_LAST_CODE=$code; fi
}

s3_explain_failure() {
  case "$S3_LAST_CODE" in
    000) S3_PROBE_ERROR="couldn't connect to $ORCHARD_S3_ENDPOINT" ;;
    404) S3_PROBE_ERROR="the bucket $ORCHARD_S3_BUCKET does not exist at $ORCHARD_S3_ENDPOINT" ;;
    401|403) S3_PROBE_ERROR="the key was refused; check it can list, read, write and delete in $ORCHARD_S3_BUCKET" ;;
    301|400) S3_PROBE_ERROR="the region or the addressing style looks wrong for this bucket" ;;
    *) S3_PROBE_ERROR="the storage answered with HTTP $S3_LAST_CODE" ;;
  esac
}

s3_probe() {
  local base key=.orchard-connection-test scheme host
  S3_PROBE_ERROR=''
  if ! curl_can_sign; then
    S3_PROBE_ERROR='this curl is too old to test the connection'
    return 2
  fi
  base=${ORCHARD_S3_ENDPOINT%/}
  if [ "$ORCHARD_S3_PATH_STYLE" = false ]; then
    scheme=${base%%://*}
    host=${base#*://}
    base="$scheme://$ORCHARD_S3_BUCKET.$host"
  else
    base="$base/$ORCHARD_S3_BUCKET"
  fi
  s3_request GET "$base/?list-type=2&max-keys=1"
  case "$S3_LAST_CODE" in 2*) ;; *) s3_explain_failure; return 1 ;; esac
  s3_request PUT "$base/$key"
  case "$S3_LAST_CODE" in 2*) ;; *) s3_explain_failure; return 1 ;; esac
  s3_request DELETE "$base/$key"
  case "$S3_LAST_CODE" in 2*) ;; *) s3_explain_failure; return 1 ;; esac
}

s3_values_problem() {
  case "$ORCHARD_S3_ENDPOINT" in
    http://?*|https://?*) ;;
    '') printf 'no endpoint'; return ;;
    *) printf 'the endpoint must start with https://'; return ;;
  esac
  if [ -z "$ORCHARD_S3_BUCKET" ]; then printf 'no bucket'; return; fi
  if [ "$ORCHARD_OBJECT_STORAGE" = true ] && [ "$ORCHARD_S3_BUCKET" = orchard-backups ]; then
    printf 'the bucket name orchard-backups is used by the store on this server'
    return
  fi
  if [ -z "$ORCHARD_S3_ACCESS_KEY" ]; then printf 'no access key'; return; fi
  if [ -z "$ORCHARD_S3_SECRET_KEY" ]; then printf 'no secret key'; return; fi
}

ask_secret() {
  local prompt=$1 answer='' rc=0
  printf '%s: ' "$prompt" >&2
  trap '' TTIN TTOU
  IFS= read -r -s answer <&3 2>/dev/null || rc=$?
  trap - TTIN TTOU
  printf '\n' >&2
  [ "$rc" -eq 0 ] || return 0
  answer=${answer%$'\r'}
  printf '%s' "$answer"
}

s3_ask_settings() {
  local location account
  echo
  echo "  1) Amazon S3"
  echo "  2) Cloudflare R2"
  echo "  3) Backblaze B2"
  echo "  4) Hetzner Object Storage"
  echo "  5) MinIO, or another S3-compatible service"
  case "$(ask 'Provider' 1)" in
    1|aws|s3)
      ORCHARD_S3_REGION=$(ask 'Region' "${ORCHARD_S3_REGION:-us-east-1}")
      ORCHARD_S3_ENDPOINT="https://s3.$ORCHARD_S3_REGION.amazonaws.com"
      ORCHARD_S3_PATH_STYLE=false
      ;;
    2|r2)
      account=$(ask 'Account ID')
      ORCHARD_S3_ENDPOINT="https://$account.r2.cloudflarestorage.com"
      ORCHARD_S3_REGION=auto
      ORCHARD_S3_PATH_STYLE=true
      ;;
    3|b2)
      ORCHARD_S3_REGION=$(ask 'Region' "${ORCHARD_S3_REGION:-us-west-004}")
      ORCHARD_S3_ENDPOINT="https://s3.$ORCHARD_S3_REGION.backblazeb2.com"
      ORCHARD_S3_PATH_STYLE=true
      ;;
    4|hetzner)
      location=$(ask 'Location' "${ORCHARD_S3_REGION:-fsn1}")
      ORCHARD_S3_REGION=$location
      ORCHARD_S3_ENDPOINT="https://$location.your-objectstorage.com"
      ORCHARD_S3_PATH_STYLE=true
      ;;
    *)
      ORCHARD_S3_ENDPOINT=$(ask 'Endpoint' "$ORCHARD_S3_ENDPOINT")
      ORCHARD_S3_REGION=$(ask 'Region' "${ORCHARD_S3_REGION:-us-east-1}")
      ORCHARD_S3_PATH_STYLE=true
      ;;
  esac
  ORCHARD_S3_BUCKET=$(ask 'Bucket' "$ORCHARD_S3_BUCKET")
  ORCHARD_S3_ACCESS_KEY=$(ask 'Access key' "$ORCHARD_S3_ACCESS_KEY")
  ORCHARD_S3_SECRET_KEY=$(ask_secret 'Secret key')
}

s3_try_settings() {
  local problem rc=0
  problem=$(s3_values_problem)
  if [ -n "$problem" ]; then
    S3_PROBE_ERROR=$problem
    return 1
  fi
  s3_probe || rc=$?
  if [ "$rc" -eq 2 ]; then
    info "$S3_PROBE_ERROR here; Orchard tests it again when it starts"
    rc=0
  fi
  return "$rc"
}

choose_s3_storage() {
  if [ "$ORCHARD_S3" = false ]; then return 0; fi
  if [ -n "$ORCHARD_S3_SECRET_KEY_FILE" ]; then
    if ! ORCHARD_S3_SECRET_KEY=$(tr -d '\r\n' < "$ORCHARD_S3_SECRET_KEY_FILE" 2>/dev/null); then
      warn "couldn't read $ORCHARD_S3_SECRET_KEY_FILE"
      ORCHARD_S3_SECRET_KEY=''
    fi
  fi
  local given=false interactive=true
  [ "$ASSUME_YES" = true ] && interactive=false
  if [ -n "$ORCHARD_S3_ENDPOINT$ORCHARD_S3_BUCKET$ORCHARD_S3_ACCESS_KEY" ]; then given=true; fi

  if [ "$given" = false ]; then
    [ "$interactive" = true ] || return 0
    if [ "$(ask_yes_no '      Add S3-compatible storage for backups and uploads now?' no)" != yes ]; then
      return 0
    fi
    s3_ask_settings
  fi

  while true; do
    if s3_try_settings; then
      S3_READY=true
      info "S3 storage: $ORCHARD_S3_BUCKET at $ORCHARD_S3_ENDPOINT"
      return 0
    fi
    warn "S3 storage: $S3_PROBE_ERROR"
    if [ "$interactive" = false ]; then
      info "continuing without S3; add it later with 'sudo orchardctl backups s3 set'"
      return 0
    fi
    case "$(ask 'Try again, or skip S3 for now? (retry/skip)' retry)" in
      r|retry) s3_ask_settings ;;
      *)
        info "skipped; add it later with 'sudo orchardctl backups s3 set'"
        return 0
        ;;
    esac
  done
}

apply_s3_storage() {
  if [ "$S3_READY" != true ]; then return 0; fi
  if ORCHARD_S3_ACCESS_KEY="$ORCHARD_S3_ACCESS_KEY" ORCHARD_S3_SECRET_KEY="$ORCHARD_S3_SECRET_KEY" \
    orchardctl backups s3 set \
    --endpoint "$ORCHARD_S3_ENDPOINT" \
    --bucket "$ORCHARD_S3_BUCKET" \
    --region "${ORCHARD_S3_REGION:-auto}" \
    --path-style "${ORCHARD_S3_PATH_STYLE:-true}" >/dev/null 2>&1; then
    info "S3 storage saved"
  else
    S3_READY=false
    warn "couldn't save the S3 settings; add them with 'sudo orchardctl backups s3 set' or under Instance admin"
  fi
}

control_plane_dump_values() {
  if [ "$ORCHARD_OBJECT_STORAGE" != true ]; then return 0; fi
  if [ "$PREVIOUS_INSTALL" = true ] && [ "$(reuse_value '.databaseDumps.enabled')" != true ]; then return 0; fi
  cat <<EOF

# A daily dump of Orchard's own database, kept in the store on this box. That is
# undo, not disaster recovery: the dumps share a disk with the database.
databaseDumps:
  enabled: true
  image: postgres:18.7-alpine@sha256:75dcac3dfb1cd01ca3536910bbc84128759362f8b118bf8c55b38a94f68f3b73
  destination:
    bucket: orchard-backups
    prefix: _control-plane
    endpointURL: http://object-storage.orchard-object-storage.svc.cluster.local:9000
    secretName: orchard-object-storage
    keep: 7
  targets:
    - name: orchard
      host: orchard-db-rw
      database: orchard
      user: orchard
      passwordSecret:
        name: orchard-db-app
EOF
}

RELEASE_KEYS="MCowBQYDK2VwAyEAGZ/AMiI95EFw93YNrsui6YQg3FMqdUVZ1FQh/+k92co="

# Images from anywhere but a published Orchard release have no signature to check.
unsigned_commands_allowed() {
  if [ "${ORCHARD_ALLOW_UNSIGNED_COMMANDS:-}" = true ] \
     || grep -qs '^ORCHARD_ALLOW_UNSIGNED_COMMANDS=true$' "$STATE_DIR/env" \
     || [ "$IMAGE_REGISTRY" != ghcr.io ] \
     || [ "$IMAGE_REPOSITORY" != hackclub/orchard ] \
     || ! [[ "$IMAGE_TAG" =~ ^(latest|v?[0-9]+\.[0-9]+\.[0-9]+.*)?$ ]]; then
    echo true
  else
    echo false
  fi
}

openssl_checks_signatures() {
  openssl pkeyutl -help 2>&1 | grep -q rawin
}

verify_bootstrap() {
  local script=$1 dir key sum verified=false
  [ -n "$RELEASE_KEYS" ] || return 0
  [ "$(unsigned_commands_allowed)" = true ] && return 0
  if ! openssl_checks_signatures; then
    warn "this openssl can't check release signatures; not installing the host commands"
    return 1
  fi
  dir=$(mktemp -d)
  kubectl -n orchard exec deploy/server -- cat /app/hostbin/hostbin.manifest > "$dir/manifest" 2>/dev/null || true
  kubectl -n orchard exec deploy/server -- cat /app/hostbin/hostbin.sig 2>/dev/null | base64 -d > "$dir/sig" 2>/dev/null || true
  for key in $RELEASE_KEYS; do
    printf -- '-----BEGIN PUBLIC KEY-----\n%s\n-----END PUBLIC KEY-----\n' "$key" > "$dir/key.pem"
    if openssl pkeyutl -verify -pubin -inkey "$dir/key.pem" -rawin -in "$dir/manifest" -sigfile "$dir/sig" >/dev/null 2>&1; then
      verified=true
      break
    fi
  done
  sum=$(sha256sum "$script" | cut -d' ' -f1)
  if [ "$verified" != true ] || ! grep -qx "sha256 $sum orchard-sync-commands" "$dir/manifest"; then
    rm -rf "$dir"
    warn "the host commands in the server image aren't signed by an Orchard release; not installing them"
    return 1
  fi
  rm -rf "$dir"
}

k3s_download() {
  curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" INSTALL_K3S_CHANNEL="$K3S_CHANNEL" sh -s - server \
    --disable=traefik \
    --write-kubeconfig-mode=600 \
    --service-node-port-range="$NODE_PORT_RANGE"
}

coredns_custom_manifest() {
  cat <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-custom
  namespace: kube-system
data:
  orchard-reverse-dns.override: |
    acl in-addr.arpa ip6.arpa {
      block type PTR
    }
YAML
}

# Without this any pod can sweep the service CIDR with reverse lookups and read
# <service>.<namespace>.svc for every Service in the cluster.
harden_coredns() {
  coredns_custom_manifest | kubectl apply -f -
  if kubectl -n kube-system get deploy coredns >/dev/null 2>&1; then
    kubectl -n kube-system rollout restart deploy/coredns || true
  fi
}

wait_for_node() {
  local tries=0
  until [ "$(kubectl get nodes --no-headers 2>/dev/null | wc -l)" -gt 0 ]; do
    tries=$((tries + 1))
    if [ $tries -ge 90 ]; then
      journalctl -u k3s --no-pager -n 30 2>/dev/null \
        | grep -aiE 'level=(error|fatal)|server is not ready' | tail -3 >&2
      return 1
    fi
    sleep 2
  done
  kubectl wait --for=condition=Ready node --all --timeout=180s >/dev/null
}

lan_cidrs() {
  ip -4 route show scope link 2>/dev/null \
    | awk '$1 ~ /\// && $2 == "dev" && $3 !~ /^(cni|flannel|veth|docker|br-|lo|tailscale)/ {print $1}' \
    | sort -u
}

ufw_port_denied() {
  ufw status 2>/dev/null | awk -v port="$1" '
    ($1 == port || $1 == port "/tcp") && $2 ~ /^(DENY|REJECT)$/ { found = 1 }
    END { exit !found }
  '
}

ufw_rules() {
  local lo=$1 hi=$2 cidr
  ufw allow from 10.42.0.0/16 to any comment 'k3s pods'
  ufw allow from 10.43.0.0/16 to any comment 'k3s services'
  for cidr in $(lan_cidrs) 100.64.0.0/10; do
    ufw allow from "$cidr" to any port 6443 proto tcp comment 'kubernetes api'
  done
  ufw deny 9100/tcp comment 'node-exporter, cluster only'
  ufw deny 8472/udp comment 'flannel vxlan, single node'
  if [ "$INGRESS_MODE" != tunnel ]; then
    ufw_port_denied "$HTTP_PORT" || ufw allow "$HTTP_PORT/tcp" comment 'orchard http'
    ufw_port_denied "$HTTPS_PORT" || ufw allow "$HTTPS_PORT/tcp" comment 'orchard https'
    ufw allow "$lo:$hi/tcp" comment 'orchard app ports'
    ufw allow "$lo:$hi/udp" comment 'orchard app ports'
  fi
}

firewalld_rules() {
  local lo=$1 hi=$2 cidr
  firewall-cmd --permanent --zone=trusted --add-source=10.42.0.0/16
  firewall-cmd --permanent --zone=trusted --add-source=10.43.0.0/16
  for cidr in $(lan_cidrs) 100.64.0.0/10; do
    firewall-cmd --permanent \
      --add-rich-rule="rule family=ipv4 source address=$cidr port port=6443 protocol=tcp accept"
  done
  firewall-cmd --permanent --add-rich-rule="rule port port=9100 protocol=tcp drop"
  firewall-cmd --permanent --add-rich-rule="rule port port=8472 protocol=udp drop"
  if [ "$INGRESS_MODE" != tunnel ]; then
    firewall-cmd --permanent --add-port="$HTTP_PORT/tcp"
    firewall-cmd --permanent --add-port="$HTTPS_PORT/tcp"
    firewall-cmd --permanent --add-port="$lo-$hi/tcp"
    firewall-cmd --permanent --add-port="$lo-$hi/udp"
  fi
  firewall-cmd --reload
}

configure_firewall() {
  local lo=${NODE_PORT_RANGE%-*} hi=${NODE_PORT_RANGE#*-} port
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    run_step "configuring ufw for k3s and Orchard" 10s ufw_rules "$lo" "$hi"
    if [ "$INGRESS_MODE" != tunnel ]; then
      for port in "$HTTP_PORT" "$HTTPS_PORT"; do
        if ufw_port_denied "$port"; then
          warn "ufw has a deny rule for port $port, and the installer left it in place."
          note "Kubernetes traffic can pass around ufw, so don't rely on this rule to close the port."
          note "To block it, use your provider's firewall."
        fi
      done
    fi
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    run_step "configuring firewalld for k3s and Orchard" 20s firewalld_rules "$lo" "$hi"
  else
    info "no host firewall active; install/README.md lists what this machine will listen on"
    note "Close 9100/tcp (node metrics) and 8472/udp (flannel) to the internet in your provider's firewall."
  fi
}

allow_rootless_builds() {
  local key=kernel.apparmor_restrict_unprivileged_userns
  [ "$(sysctl -n "$key" 2>/dev/null)" = 1 ] || return 0
  if [ -f "$VALUES_FILE" ] \
    && [ "$(yq -r '.builderSandbox.enabled == true or .builders.allowPrivilegedOnHost == true' "$VALUES_FILE" 2>/dev/null)" = true ]; then
    return 0
  fi
  printf '%s = 0\n' "$key" > "$SYSCTL_CONF"
  if sysctl -q -w "$key=0"; then
    info "allowed user namespaces so builds can run rootless"
  else
    warn "couldn't set $key to 0; builds fail until it is"
  fi
}

containerd_apparmor_profile() {
  cat <<'PROFILE'
abi <abi/3.0>,
#include <tunables/global>

profile cri-containerd.apparmor.d flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  network,
  capability,
  file,
  umount,
  signal (receive) peer=unconfined,
  signal (receive) peer=runc,
  signal (receive) peer=crun,
  signal (send,receive) peer=cri-containerd.apparmor.d,
  signal (send,receive) peer=cri-containerd.apparmor.d//&unconfined,

  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9/],[^1-9/][^0-9/],[^1-9s/][^0-9y/][^0-9s/],[^1-9/][^0-9/][^0-9/][^0-9/]*}/** w,
  deny @{PROC}/sys/[^k]** w,
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,

  deny mount,

  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/devices/virtual/powercap/** rwklx,
  deny /sys/kernel/security/** rwklx,

  ptrace (trace,tracedby,read,readby) peer=cri-containerd.apparmor.d,
  ptrace (trace,tracedby,read,readby) peer=cri-containerd.apparmor.d//&unconfined,
}
PROFILE
}

allow_container_signals() {
  [ "$(cat "$APPARMOR_STACKING_PROC" 2>/dev/null)" = 1 ] || return 0
  command -v apparmor_parser >/dev/null 2>&1 || return 0
  [ -d "$APPARMOR_DIR/abi" ] && [ -d "$APPARMOR_DIR/abstractions" ] || return 0
  local file="$APPARMOR_DIR/cri-containerd.apparmor.d"
  containerd_apparmor_profile > "$file"
  if apparmor_parser -r -W "$file" >/dev/null 2>&1; then
    info "let processes in a container signal each other under this kernel's AppArmor stacking"
  else
    warn "couldn't load $file; databases can't checkpoint until it loads"
  fi
}

image_gc_conf() {
  cat <<'YAML'
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
imageGCHighThresholdPercent: 70
imageGCLowThresholdPercent: 50
imageMaximumGCAge: 72h
YAML
}

write_image_gc_defaults() {
  local dir
  dir=$(dirname "$IMAGE_GC_FILE")
  mkdir -p "$(dirname "$dir")"
  [ -d "$dir" ] || mkdir -m 700 "$dir"
  (umask 077 && image_gc_conf > "$IMAGE_GC_FILE")
}

install_k3s() {
  step
  configure_firewall
  allow_rootless_builds
  allow_container_signals

  local gc_pending=false
  if [ ! -e "$IMAGE_GC_FILE" ]; then
    write_image_gc_defaults
    gc_pending=true
  fi

  if command -v k3s >/dev/null 2>&1; then
    info "k3s already installed, leaving it alone"
  else
    gc_pending=false
    run_step "downloading and starting k3s" 1m k3s_download
  fi

  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  if [ "$gc_pending" = true ]; then
    run_step "restarting k3s to remove unused images sooner" 45s restart_k3s
  fi
  run_step "waiting for the node to be ready" 30s wait_for_node
  run_step "blocking reverse DNS lookups from pods" 15s harden_coredns
}

helm_download() {
  curl -fsSL https://raw.githubusercontent.com/helm/helm/refs/tags/v4.3.0/scripts/get-helm-3 | bash -s -- --version "$HELM_VERSION"
}

ensure_helm() {
  step
  if command -v helm >/dev/null 2>&1; then
    info "helm already installed"
    return
  fi
  run_step "downloading helm" 20s helm_download
}

YQ_PINNED=v4.54.3
YQ_VERSION=${YQ_VERSION:-$YQ_PINNED}

yq_sha256() {
  if [ -n "${YQ_SHA256:-}" ]; then
    printf '%s' "$YQ_SHA256"
    return
  fi
  [ "$YQ_VERSION" = "$YQ_PINNED" ] || return 1
  case "$ARCH" in
    amd64) printf '%s' 129534601871538efe0ba4c5e62a34fb1d5f469bcb975c4fddeb467d82974973 ;;
    arm64) printf '%s' 89f69310b61b68d1245065a1241d1fc843f7a36cd6103ffd77ad987613bd1b67 ;;
    *) return 1 ;;
  esac
}

yq_download() {
  local sum tmp
  if ! sum=$(yq_sha256); then
    echo "yq $YQ_VERSION has no known checksum; set YQ_SHA256 to the sha256 of yq_linux_$ARCH" >&2
    return 1
  fi
  tmp=$(mktemp)
  if ! curl -fsSL -o "$tmp" "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${ARCH}"; then
    rm -f "$tmp"
    return 1
  fi
  if [ "$(sha256sum "$tmp" | cut -d' ' -f1)" != "$sum" ]; then
    rm -f "$tmp"
    echo "yq_linux_$ARCH $YQ_VERSION doesn't match its sha256" >&2
    return 1
  fi
  install -m 0755 "$tmp" /usr/local/bin/yq
  rm -f "$tmp"
}

# Backs orchard-config. Editing the values file by hand is the alternative, and
# a stray indent there breaks the next upgrade rather than the edit.
ensure_yq() {
  if command -v yq >/dev/null 2>&1; then
    return
  fi
  run_step "downloading yq" 20s yq_download
}

add_helm_repos() {
  helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
  helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
  helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
  helm repo update >/dev/null
}

install_operators() {
  step

  run_step "fetching chart repositories" 20s add_helm_repos

  # A LoadBalancer service means k3s servicelb, which binds 80 and 443 on the
  # node. In tunnel mode cloudflared reaches Traefik over its ClusterIP from
  # inside the cluster, so claiming the host ports would only pick a fight with
  # whatever else is on them.
  local traefik_service=LoadBalancer
  if [ "$INGRESS_MODE" = tunnel ]; then traefik_service=ClusterIP; fi

  run_step "Traefik" 1m30s helm upgrade --install traefik traefik/traefik \
    --namespace traefik --create-namespace \
    --set gateway.enabled=false \
    --set service.spec.type="$traefik_service" \
    --set ports.web.exposedPort="$HTTP_PORT" \
    --set ports.websecure.exposedPort="$HTTPS_PORT" \
    --set accessLog.enabled=true \
    --set accessLog.format=json \
    --set accessLog.fields.headers.names.User-Agent=keep \
    --set resources.requests.cpu=20m \
    --set resources.requests.memory=48Mi \
    --wait --timeout 10m

  local cnpg_installed cnpg_target step_version
  cnpg_installed=$(helm_chart_version cnpg cnpg-system cloudnative-pg)
  cnpg_target=$(newer_version "$cnpg_installed" "$CNPG_CHART_VERSION")
  if [ "$cnpg_target" != "$CNPG_CHART_VERSION" ]; then
    info "keeping CloudNativePG chart $cnpg_target, newer than $CNPG_CHART_VERSION"
  fi
  for step_version in $(cnpg_chart_versions | cnpg_upgrade_steps "$cnpg_installed" "$cnpg_target"); do
    run_step "CloudNativePG $step_version" 1m install_cnpg "$step_version"
  done
  run_step "CloudNativePG" 1m install_cnpg "$cnpg_target"

  if [ -n "$CERT_ISSUER" ]; then
    run_step "cert-manager" 1m30s helm upgrade --install cert-manager jetstack/cert-manager \
      --namespace cert-manager --create-namespace \
      --set crds.enabled=true \
      --set resources.requests.memory=32Mi \
      --set webhook.resources.requests.memory=16Mi \
      --set cainjector.resources.requests.memory=32Mi \
      --wait --timeout 10m
    install_cluster_issuer
  else
    info "cert-manager skipped, TLS terminates at the tunnel"
  fi

  local plugin_installed
  plugin_installed=$(helm_chart_version plugin-barman-cloud cnpg-system plugin-barman-cloud)
  if [ "$(newer_version "$plugin_installed" "$BARMAN_PLUGIN_CHART_VERSION")" != "$BARMAN_PLUGIN_CHART_VERSION" ]; then
    info "keeping Barman Cloud plugin chart $plugin_installed, newer than $BARMAN_PLUGIN_CHART_VERSION"
    if ! barman_certificates_by_cert_manager; then
      run_step "Barman Cloud plugin certificates" 30s ensure_barman_certificates
    fi
  else
    run_step "Barman Cloud plugin" 1m install_barman_plugin
  fi

  settle_backup_method
}

newer_version() {
  if [ -z "$1" ]; then printf '%s' "$2"; return; fi
  if [ -z "$2" ]; then printf '%s' "$1"; return; fi
  printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1
}

helm_chart_version() {
  local release=$1 namespace=$2 chart=$3 listing
  listing=$(helm list --namespace "$namespace" --filter "^$release\$" -o json 2>/dev/null) || return 0
  listing=$(printf '%s' "$listing" | yq -p json -r '.[0].chart // ""' 2>/dev/null) || return 0
  case "$listing" in
    "$chart"-*) printf '%s' "${listing#"$chart"-}" ;;
  esac
}

cnpg_chart_versions() {
  helm search repo cnpg/cloudnative-pg --versions -o json 2>/dev/null \
    | yq -p json -r '.[].version' 2>/dev/null || true
}

cnpg_upgrade_steps() {
  local installed=$1 target=$2
  [ -n "$installed" ] || return 0
  grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | awk -F. -v from="$installed" -v to="$target" '
    BEGIN { split(from, f, "."); split(to, t, ".") }
    $1 == f[1] && $1 == t[1] && $2 + 0 > f[2] + 0 && $2 + 0 < t[2] + 0 { best[$2 + 0] = $0 }
    END { for (m = f[2] + 1; m < t[2] + 0; m++) if (m in best) print best[m] }
  '
}

install_cnpg() {
  helm upgrade --install cnpg cnpg/cloudnative-pg \
    --version "$1" \
    --set-string config.data.ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES=true \
    --set resources.requests.cpu=20m \
    --set resources.requests.memory=48Mi \
    --namespace cnpg-system --create-namespace \
    --wait --timeout 10m
}

barman_plugin_sha256() {
  if [ -n "${BARMAN_PLUGIN_CHART_SHA256:-}" ]; then
    printf '%s' "$BARMAN_PLUGIN_CHART_SHA256"
    return
  fi
  [ "$BARMAN_PLUGIN_CHART_VERSION" = "$BARMAN_PLUGIN_PINNED" ] || return 1
  printf '%s' 7fb78e89f25c18737e5649ae3c5e840065052f89757d541eaf310a1706ebd7dd
}

install_barman_plugin() {
  local sum dir chart rc=0
  if ! sum=$(barman_plugin_sha256); then
    echo "plugin-barman-cloud $BARMAN_PLUGIN_CHART_VERSION has no known checksum; set BARMAN_PLUGIN_CHART_SHA256 to the sha256 of its chart archive" >&2
    return 1
  fi
  dir=$(mktemp -d)
  chart="$dir/plugin-barman-cloud-$BARMAN_PLUGIN_CHART_VERSION.tgz"
  if ! helm pull cnpg/plugin-barman-cloud --version "$BARMAN_PLUGIN_CHART_VERSION" -d "$dir" \
    || [ ! -f "$chart" ]; then
    rm -rf "$dir"
    return 1
  fi
  if [ "$(sha256sum "$chart" | cut -d' ' -f1)" != "$sum" ]; then
    rm -rf "$dir"
    echo "plugin-barman-cloud-$BARMAN_PLUGIN_CHART_VERSION.tgz doesn't match its sha256" >&2
    return 1
  fi
  if ! barman_certificates_by_cert_manager && ! ensure_barman_certificates; then
    rm -rf "$dir"
    return 1
  fi
  helm upgrade --install plugin-barman-cloud "$chart" \
    --namespace cnpg-system \
    --set certificate.createClientCertificate=false \
    --set certificate.createServerCertificate=false \
    --set certificate.createIssuer=false \
    --set resources.requests.cpu=10m \
    --set resources.requests.memory=32Mi \
    --wait --timeout 10m || rc=$?
  rm -rf "$dir"
  [ "$rc" -eq 0 ] || return "$rc"
  ensure_barman_certificates || return 1
  kubectl -n cnpg-system rollout status deploy/plugin-barman-cloud --timeout=5m
}

BARMAN_SERVER_SECRET=barman-cloud-server-tls
BARMAN_CLIENT_SECRET=barman-cloud-client-tls
BARMAN_CERT_RENEW_SECONDS=$((90 * 86400))

barman_certificates_by_cert_manager() {
  local found
  found=$(kubectl -n cnpg-system get certificates.cert-manager.io barman-cloud-server barman-cloud-client \
    -o name 2>/dev/null || true)
  [ -n "$found" ]
}

barman_secret_field() {
  local field=${2//./\\.}
  kubectl -n cnpg-system get secret "$1" -o "jsonpath={.data.$field}" 2>/dev/null | base64 -d 2>/dev/null
}

barman_secret_valid() {
  local crt key ca cert_pub key_pub
  crt=$(barman_secret_field "$1" tls.crt)
  key=$(barman_secret_field "$1" tls.key)
  ca=$(barman_secret_field "$1" ca.crt)
  [ -n "$crt" ] && [ -n "$key" ] && [ -n "$ca" ] || return 1
  printf '%s\n' "$ca" | openssl x509 -noout >/dev/null 2>&1 || return 1
  printf '%s\n' "$crt" | openssl x509 -noout -checkend "$BARMAN_CERT_RENEW_SECONDS" >/dev/null 2>&1 || return 1
  cert_pub=$(printf '%s\n' "$crt" | openssl x509 -noout -pubkey 2>/dev/null)
  key_pub=$(printf '%s\n' "$key" | openssl pkey -pubout 2>/dev/null)
  [ -n "$cert_pub" ] && [ "$cert_pub" = "$key_pub" ]
}

barman_sign_certificates() {
  local dns='DNS:barman-cloud,DNS:barman-cloud.cnpg-system,DNS:barman-cloud.cnpg-system.svc,DNS:barman-cloud.cnpg-system.svc.cluster.local'
  printf '%s\n' basicConstraints=critical,CA:TRUE keyUsage=critical,keyCertSign,cRLSign \
    subjectKeyIdentifier=hash >ca.ext
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout ca.key -out ca.csr -subj /CN=barman-cloud-ca >/dev/null 2>&1 || return 1
  openssl x509 -req -in ca.csr -signkey ca.key -days 3650 -extfile ca.ext \
    -set_serial "0x$(openssl rand -hex 16)" -out ca.crt >/dev/null 2>&1 || return 1
  printf '%s\n' basicConstraints=critical,CA:FALSE keyUsage=critical,digitalSignature \
    extendedKeyUsage=serverAuth "subjectAltName=$dns" >server.ext
  printf '%s\n' basicConstraints=critical,CA:FALSE keyUsage=critical,digitalSignature \
    extendedKeyUsage=clientAuth >client.ext
  local leaf
  for leaf in server client; do
    openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
      -keyout "$leaf.key" -out "$leaf.csr" -subj "/CN=barman-cloud-$leaf" >/dev/null 2>&1 || return 1
    openssl x509 -req -in "$leaf.csr" -CA ca.crt -CAkey ca.key \
      -set_serial "0x$(openssl rand -hex 16)" -days 730 -extfile "$leaf.ext" \
      -out "$leaf.pem" >/dev/null 2>&1 || return 1
    cat "$leaf.pem" ca.crt >"$leaf.crt"
  done
}

barman_apply_secret() {
  local name=$1 dir=$2 leaf=$3
  kubectl -n cnpg-system create secret generic "$name" --type=kubernetes.io/tls \
    --from-file=tls.crt="$dir/$leaf.crt" --from-file=tls.key="$dir/$leaf.key" \
    --from-file=ca.crt="$dir/ca.crt" --dry-run=client -o yaml \
    | kubectl apply -f - >/dev/null
}

issue_barman_certificates() {
  local dir rc=0
  dir=$(umask 077 && mktemp -d) || return 1
  (umask 077 && cd "$dir" && barman_sign_certificates) || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "openssl couldn't create the Barman Cloud plugin certificates" >&2
  else
    barman_apply_secret "$BARMAN_SERVER_SECRET" "$dir" server \
      && barman_apply_secret "$BARMAN_CLIENT_SECRET" "$dir" client || rc=$?
  fi
  rm -rf "$dir"
  return "$rc"
}

ensure_barman_certificates() {
  if barman_secret_valid "$BARMAN_SERVER_SECRET" && barman_secret_valid "$BARMAN_CLIENT_SECRET"; then
    return 0
  fi
  issue_barman_certificates || return 1
  if kubectl -n cnpg-system get deploy plugin-barman-cloud -o name >/dev/null 2>&1; then
    kubectl -n cnpg-system rollout restart deploy/plugin-barman-cloud >/dev/null || return 1
  fi
}

in_tree_backup_count() {
  local count
  count=$(kubectl get clusters.postgresql.cnpg.io --all-namespaces -o json 2>/dev/null \
    | yq -p json '[.items[] | select(.spec.backup.barmanObjectStore)] | length' 2>/dev/null)
  case "$count" in
    ''|*[!0-9]*) printf 0 ;;
    *) printf '%s' "$count" ;;
  esac
}

settle_backup_method() {
  IN_TREE_BACKUPS=$(in_tree_backup_count)
  if [ "$PREVIOUS_INSTALL" = true ]; then
    if [ "$(reuse_secret CNPG_BARMAN_PLUGIN)" = on ]; then BARMAN_PLUGIN=on; else BARMAN_PLUGIN=off; fi
  elif [ "$IN_TREE_BACKUPS" -gt 0 ]; then
    BARMAN_PLUGIN=off
  else
    BARMAN_PLUGIN=on
  fi
}

install_cluster_issuer() {
  if [ "$CERT_ISSUER" = selfsigned ]; then
    kubectl apply -f - >/dev/null <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned
spec:
  selfSigned: {}
EOF
    return
  fi

  local email=$ORCHARD_ACME_EMAIL email_line=''
  if [ -z "$email" ] && [ -z "$PREV_EMAIL" ] && [ "$PREVIOUS_INSTALL" != true ]; then
    email=$(kubectl get clusterissuer letsencrypt -o jsonpath='{.spec.acme.email}' 2>/dev/null || true)
  fi
  if [ -n "$email" ]; then
    email_line="
    email: $email"
  fi

  kubectl apply -f - >/dev/null <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory$email_line
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
      - http01:
          ingress:
            class: traefik
EOF
}

registry_htpasswd() {
  if command -v htpasswd >/dev/null 2>&1; then
    printf '%s\n' "$REGISTRY_PASSWORD" | htpasswd -niB "$REGISTRY_USER"
  else
    printf '%s\n' "$REGISTRY_PASSWORD" | kubectl run zot-htpasswd --rm -i --quiet --restart=Never --image=httpd:2.4.71-alpine@sha256:32bd0639bcc4917ef1fd9363a1d9dd2dd9c498565118b062a10d51e43a5c3a24 \
      --command -- htpasswd -niB "$REGISTRY_USER"
  fi
}

write_registry_auth() {
  local line
  line=$(registry_htpasswd | grep "^$REGISTRY_USER:" | head -1 | tr -d '[:space:]')
  [ -n "$line" ] || return 1
  kubectl apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: zot-auth
  namespace: orchard
stringData:
  htpasswd: "$line"
EOF
}

install_registry() {
  step

  kubectl create namespace orchard >/dev/null 2>&1 || true

  REGISTRY_PASSWORD=$(reuse_value '.builders.harbor.password')
  [ -n "$REGISTRY_PASSWORD" ] || REGISTRY_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  run_step "generating registry credentials" 30s write_registry_auth

  kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: zot-data
  namespace: orchard
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources:
    requests:
      storage: ${REGISTRY_SIZE_GB}Gi
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: zot-config
  namespace: orchard
data:
  config.json: |
    {
      "storage": {
        "rootDirectory": "/var/lib/registry",
        "gc": true,
        "gcDelay": "1h",
        "gcInterval": "24h"
      },
      "http": {
        "address": "0.0.0.0",
        "port": "5000",
        "auth": { "htpasswd": { "path": "/etc/zot-auth/htpasswd" } }
      },
      "log": { "level": "info" },
      "extensions": {
        "scrub": { "interval": "24h" }
      }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: zot
  namespace: orchard
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector:
    matchLabels: { app: zot }
  template:
    metadata:
      labels: { app: zot }
    spec:
      containers:
        - name: zot
          image: ghcr.io/project-zot/zot:v2.1.23@sha256:9d3de83ac2099e6f4843045b4c9b65b7e8baf40f92d28f54906dee9d4d390fd7
          args: ["serve", "/etc/zot/config.json"]
          ports:
            - containerPort: 5000
              hostPort: $REGISTRY_PORT
              hostIP: 127.0.0.1
          volumeMounts:
            - { name: data, mountPath: /var/lib/registry }
            - { name: config, mountPath: /etc/zot }
            - { name: auth, mountPath: /etc/zot-auth, readOnly: true }
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { cpu: "1", memory: 512Mi }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: zot-data }
        - name: config
          configMap: { name: zot-config }
        - name: auth
          secret: { secretName: zot-auth }
---
apiVersion: v1
kind: Service
metadata:
  name: zot
  namespace: orchard
spec:
  type: ClusterIP
  selector: { app: zot }
  ports:
    - port: 5000
      targetPort: 5000
EOF

  ensure_registry_mirror
  run_step "starting the registry" 2m \
    kubectl -n orchard rollout status deploy/zot --timeout=5m
  info "registry ready at $REGISTRY_HOST, mirrored to 127.0.0.1:$REGISTRY_PORT, loopback only"
}

ensure_registry_mirror() {
  local wanted pending="$STATE_DIR/k3s-restart-pending"
  wanted=$(cat <<EOF
mirrors:
  $REGISTRY_HOST:
    endpoint:
      - "http://127.0.0.1:$REGISTRY_PORT"
configs:
  "127.0.0.1:$REGISTRY_PORT":
    auth:
      username: $REGISTRY_USER
      password: "$REGISTRY_PASSWORD"
EOF
)
  if [ -f "$REGISTRIES_FILE" ]; then chmod 600 "$REGISTRIES_FILE"; fi
  if [ ! -f "$pending" ] && [ -f "$REGISTRIES_FILE" ] && [ "$(cat "$REGISTRIES_FILE")" = "$wanted" ]; then
    info "registry mirror unchanged, k3s keeps running"
    return 0
  fi
  mkdir -p "$(dirname "$REGISTRIES_FILE")" "$STATE_DIR"
  : > "$pending"
  (umask 077 && printf '%s\n' "$wanted" > "$REGISTRIES_FILE")
  chmod 600 "$REGISTRIES_FILE"
  run_step "reloading k3s with the registry mirror" 45s restart_k3s
  rm -f "$pending"
}

restart_k3s() {
  systemctl restart k3s
  local tries=0
  until kubectl get --raw /readyz >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ $tries -lt 90 ] || return 1
    sleep 2
  done
}

install_tunnel() {
  step
  if [ "$INGRESS_MODE" != tunnel ]; then
    info "not needed in $INGRESS_MODE mode"
    return 0
  fi

  kubectl create namespace cloudflared >/dev/null 2>&1 || true
  printf '%s' "$ORCHARD_TUNNEL_TOKEN" | kubectl -n cloudflared create secret generic tunnel-token \
    --from-file=token=/dev/stdin \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  kubectl apply -f - >/dev/null <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudflared
  namespace: cloudflared
spec:
  replicas: 1
  selector:
    matchLabels: { app: cloudflared }
  template:
    metadata:
      labels: { app: cloudflared }
    spec:
      containers:
        - name: cloudflared
          image: cloudflare/cloudflared:2026.11.0@sha256:b94b96edf2c9c4360f8879c8580cfaa99077f19c849ec595ca2f711b27d4f344
          args: ["tunnel", "--no-autoupdate", "run"]
          env:
            - name: TUNNEL_TOKEN
              valueFrom:
                secretKeyRef: { name: tunnel-token, key: token }
          resources:
            requests: { cpu: 20m, memory: 32Mi }
            limits: { cpu: 500m, memory: 256Mi }
EOF
  run_step "connecting the tunnel" 30s \
    kubectl -n cloudflared rollout status deploy/cloudflared --timeout=5m
  isolate_traefik_to_tunnel
}

cluster_pod_cidrs() {
  local cidrs
  cidrs=$(KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl get nodes \
    -o jsonpath='{range .items[*]}{.spec.podCIDRs[*]}{"\n"}{end}' 2>/dev/null | tr ' \n' ',' | sed 's/,*$//')
  printf '%s' "${cidrs:-10.42.0.0/16}"
}

isolate_traefik_to_tunnel() {
  kubectl apply -f - >/dev/null <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: tunnel-only-ingress
  namespace: traefik
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: traefik
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: cloudflared }
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: orchard }
      ports:
        - { protocol: TCP, port: 8000 }
        - { protocol: TCP, port: 8443 }
    - ports:
        - { protocol: TCP, port: 8080 }
        - { protocol: TCP, port: 9100 }
EOF
}

live_volume_gb() {
  local namespace=$1 claim=$2 wanted=$3 live
  live=$(KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n "$namespace" get pvc "$claim" \
    -o jsonpath='{.spec.resources.requests.storage}' 2>/dev/null || true)
  live=${live%Gi}
  case "$live" in
    ''|*[!0-9]*) printf '%s' "$wanted" ;;
    *) printf '%s' "$live" ;;
  esac
}

size_workloads() {
  if [ "$MEM_MB" -ge 15000 ]; then MAX_BUILDS=3
  elif [ "$MEM_MB" -ge 7500 ]; then MAX_BUILDS=2
  else MAX_BUILDS=1
  fi

  BUILD_CACHE_GB=$((DISK_GB / 5))
  if [ "$BUILD_CACHE_GB" -gt 60 ]; then BUILD_CACHE_GB=60; fi
  if [ "$BUILD_CACHE_GB" -lt 5 ]; then BUILD_CACHE_GB=5; fi
  BUILD_CACHE_GB=$(live_volume_gb orchard-builders buildkit-cache "$BUILD_CACHE_GB")

  REGISTRY_SIZE_GB=$((DISK_GB / 5))
  if [ "$REGISTRY_SIZE_GB" -gt 50 ]; then REGISTRY_SIZE_GB=50; fi
  if [ "$REGISTRY_SIZE_GB" -lt 5 ]; then REGISTRY_SIZE_GB=5; fi
  REGISTRY_SIZE_GB=$(live_volume_gb orchard zot-data "$REGISTRY_SIZE_GB")

  LOGS_SIZE_GB=$((DISK_GB / 10))
  if [ "$LOGS_SIZE_GB" -gt 20 ]; then LOGS_SIZE_GB=20; fi
  if [ "$LOGS_SIZE_GB" -lt 5 ]; then LOGS_SIZE_GB=5; fi
  LOGS_SIZE_GB=$(live_volume_gb orchard-metrics data-victorialogs-0 "$LOGS_SIZE_GB")
  LOGS_MAX_DISK_GB=$((LOGS_SIZE_GB * 4 / 5))

  OBJECT_STORAGE_GB=$((DISK_GB / 5))
  if [ "$OBJECT_STORAGE_GB" -gt 50 ]; then OBJECT_STORAGE_GB=50; fi
  if [ "$OBJECT_STORAGE_GB" -lt 5 ]; then OBJECT_STORAGE_GB=5; fi
  OBJECT_STORAGE_GB=$(live_volume_gb orchard-object-storage object-storage-data "$OBJECT_STORAGE_GB")

  SMALL_BOX=false
  if [ "$MEM_MB" -lt 7500 ]; then SMALL_BOX=true; fi
  TINY_BOX=false
  if [ "$MEM_MB" -lt "$TINY_BOX_MB" ]; then TINY_BOX=true; fi

  DB_DEFAULT_MEMORY_MB=1024
  if [ "$MEM_MB" -lt 9000 ]; then DB_DEFAULT_MEMORY_MB=512; fi

  APP_DEFAULT_MEMORY_MB=1024
  if [ "$MEM_MB" -lt 7500 ]; then APP_DEFAULT_MEMORY_MB=256
  elif [ "$MEM_MB" -lt 17000 ]; then APP_DEFAULT_MEMORY_MB=512; fi

  info "concurrent builds: $MAX_BUILDS, build cache: ${BUILD_CACHE_GB}G, registry: ${REGISTRY_SIZE_GB}G, backups: ${OBJECT_STORAGE_GB}G, logs: ${LOGS_SIZE_GB}G"
  if [ "$TINY_BOX" = true ]; then
    info "under 3.5G of RAM: Orchard itself runs on its smallest footprint to leave room for apps"
  elif [ "$SMALL_BOX" = true ]; then
    info "under 8G of RAM: metrics, logs and scanning run trimmed, with a week of logs"
  fi
}

observability_values() {
  local logs_retention=14d scans=2
  local vm_res='' vmagent_res='' ksm_res='' node_res='' vl_res='' vector_res='' trivy_res=''
  if [ "$SMALL_BOX" = true ]; then
    logs_retention=7d
    scans=1
    vm_res='
    resources:
      requests: { cpu: 50m, memory: 96Mi }
      limits: { cpu: "1", memory: 384Mi }'
    vmagent_res='
  vmagent:
    resources:
      requests: { cpu: 20m, memory: 64Mi }
      limits: { cpu: 500m, memory: 256Mi }'
    ksm_res='
  kubeStateMetrics:
    resources:
      requests: { cpu: 10m, memory: 32Mi }
      limits: { cpu: 200m, memory: 128Mi }'
    node_res='
  nodeExporter:
    resources:
      requests: { cpu: 10m, memory: 16Mi }
      limits: { cpu: 200m, memory: 64Mi }'
    vl_res='
    resources:
      requests: { cpu: 50m, memory: 96Mi }
      limits: { cpu: "1", memory: 384Mi }'
    vector_res='
  vector:
    bufferEvents: 5000
    resources:
      requests: { cpu: 20m, memory: 64Mi }
      limits: { cpu: 500m, memory: 256Mi }'
    trivy_res='
  resources:
    requests: { cpu: 50m, memory: 256Mi }
    limits: { cpu: "2", memory: 1Gi }'
  fi

  cat <<EOF
metrics:
  enabled: $ORCHARD_METRICS
  victoriametrics:
    retention: 7d$vm_res
    storage:
      size: 5Gi
      storageClass: local-path$vmagent_res$ksm_res$node_res

logs:
  enabled: $ORCHARD_LOGS
  retention: $logs_retention
  maxDiskSpaceUsage: ${LOGS_MAX_DISK_GB}GiB
  victorialogs:$vl_res
    storage:
      size: ${LOGS_SIZE_GB}Gi
      storageClass: local-path$vector_res

# The Orchard scanner. It pulls each image from zot with the registry
# credentials above, so scans need nothing else configured.
trivy:
  enabled: $ORCHARD_IMAGE_SCANNING
  maxConcurrentScans: $scans
  storage:
    storageClass: local-path$trivy_res

# Database backups, checkpoints, point-in-time restore, forks and the trash
# land in an S3 store on this box. That is undo, not disaster recovery: the
# copies share a disk with the databases. To add S3 storage, run
# 'orchardctl backups s3 set' or use Instance admin.
objectStorage:
  local:
    enabled: $ORCHARD_OBJECT_STORAGE
    storage:
      size: ${OBJECT_STORAGE_GB}Gi
      storageClass: local-path

# The backup proxy hands each database credentials for its own prefix only,
# so no tenant ever holds the object store's root key.
r2Proxy:
  enabled: true
  replicas: 1
  resources:
    requests: { cpu: 20m, memory: 32Mi }
    limits: { cpu: "1", memory: 512Mi }
$(control_plane_dump_values)
EOF
}

# Pull a server env value out of the values file a previous run wrote, so a
# re-run preserves it instead of rotating it.
reuse_secret() {
  reuse_value ".server.env[]? | select(.name == \"$1\") | .value"
}

reuse_value() {
  local value
  [ -f "$VALUES_FILE" ] || return 0
  command -v yq >/dev/null 2>&1 || return 0
  value=$(yq -r "$1" "$VALUES_FILE" 2>/dev/null | head -1)
  [ "$value" = null ] && value=
  printf '%s' "$value"
}

write_values() {
  step

  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"

  if [ -f "$VALUES_FILE" ]; then require_readable_values; fi

  # Re-running the installer is the supported way to pick up new host commands.
  # Minting fresh secrets would log every user out, and worse, a new
  # SECRETS_ENCRYPTION_KEY makes every secret already stored in the database
  # permanently undecryptable. Carry them over.
  JWT_SECRET=$(reuse_secret JWT_SECRET)
  ENCRYPTION_KEY=$(reuse_secret SECRETS_ENCRYPTION_KEY)
  SSO_KEY=$(reuse_secret SSO_ENCRYPTION_KEY)
  # Shared with the MCP below rather than minted per process: it is what the
  # API recognises when the MCP acts for a consenting user, so a mismatch shows
  # up as every tool call failing rather than as anything failing to start.
  MCP_TOKEN=$(reuse_secret MCP_SERVICE_TOKEN)
  [ -n "$JWT_SECRET" ] || JWT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | head -c 43)
  [ -n "$ENCRYPTION_KEY" ] || ENCRYPTION_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '\n=' | head -c 32)
  [ -n "$SSO_KEY" ] || SSO_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '\n=' | head -c 32)
  [ -n "$MCP_TOKEN" ] || MCP_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | head -c 43)

  if [ -f "$VALUES_FILE" ]; then
    merge_values
  else
    local rendered
    rendered=$(render_values)
    printf '%s\n' "$rendered" > "$VALUES_FILE"
    chmod 600 "$VALUES_FILE"
  fi
}

render_values() {
  local url_suffix=$HTTP_SUFFIX
  local scheme=http entrypoint=web tls_enabled=false tls_issuer= mcp_tls_issuer=
  if [ "$USE_TLS" = true ]; then
    scheme=https; entrypoint=websecure; tls_enabled=true; url_suffix=$HTTPS_SUFFIX
    # Without this the IngressRoute gets a bare `tls:` block and Traefik
    # terminates with its self-signed TRAEFIK DEFAULT CERT, which every browser
    # rejects. The chart issues the real one against the ClusterIssuer above.
    tls_issuer="
    issuerRef:
      name: $CERT_ISSUER
      kind: ClusterIssuer"
    # The same trap on the MCP's own route, one level deeper in the values. An
    # MCP client refuses a self-signed certificate outright.
    mcp_tls_issuer="
      issuerRef:
        name: $CERT_ISSUER
        kind: ClusterIssuer"
  fi
  if [ "$INGRESS_MODE" = tunnel ]; then scheme=https; url_suffix=''; fi

  local cookie_secure=true
  if [ "$scheme" = http ]; then cookie_secure=false; fi

  local cname_env='' pinned_cname
  pinned_cname=$(reuse_secret INGRESS_CNAME)
  if [ -n "$pinned_cname" ] && [ -n "$ORCHARD_INGRESS_CNAME" ]; then
    cname_env="
    - { name: INGRESS_CNAME, value: $ORCHARD_INGRESS_CNAME }"
  fi

  local public_ip_pin=''
  public_ip_pin=$(reuse_value '.tenant.publicIp')
  if [ -n "$public_ip_pin" ] && [ "$ORCHARD_PUBLIC_IP" != "$PREV_PUBLIC_IP" ]; then
    public_ip_pin=$ORCHARD_PUBLIC_IP
  fi
  if [ -n "$public_ip_pin" ]; then
    public_ip_pin="
  publicIp: \"$public_ip_pin\""
  fi

  local builder_ingress_egress=''
  if [ "$INGRESS_MODE" != tunnel ]; then
    builder_ingress_egress="
    - namespace: traefik
      podLabels:
        app.kubernetes.io/name: traefik
      ports:
        - port: 8000
        - port: 8443"
  fi

  local client_ip_block='
clientIp:
  trustProxy: "1"'
  if [ "$INGRESS_MODE" = tunnel ]; then
    client_ip_block="$client_ip_block
  header: cf-connecting-ip
  headerFrom: \"$(cluster_pod_cidrs)\""
  fi

  local server_res='' server_tiny_env='' frontend_res='' frontend_tiny_env='' postgres_res='' redis_res=''
  if [ "${TINY_BOX:-false}" = true ]; then
    server_res='
  resources:
    requests: { cpu: 50m, memory: 192Mi }
    limits: { cpu: "2", memory: 1Gi }'
    server_tiny_env='
    - { name: NODE_OPTIONS, value: "--max-old-space-size=512" }
    - { name: BUILDER_MEMORY_REQUEST, value: 512Mi }'
    frontend_res='
  resources:
    requests: { cpu: 20m, memory: 64Mi }
    limits: { cpu: "1", memory: 512Mi }'
    frontend_tiny_env='
    - { name: NODE_OPTIONS, value: "--max-old-space-size=192" }'
    postgres_res='
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { cpu: "2", memory: 1Gi }'
    redis_res='
  resources:
    requests: { cpu: 20m, memory: 32Mi }
    limits: { cpu: 500m, memory: 256Mi }'
  fi

  local db_memory_env=
  if [ ! -f "$VALUES_FILE" ]; then
    db_memory_env="
    - { name: DATABASE_DEFAULT_MEMORY_MB, value: \"$DB_DEFAULT_MEMORY_MB\" }
    - { name: DEFAULT_APP_MEMORY_MB, value: \"$APP_DEFAULT_MEMORY_MB\" }
    - { name: TENANT_QUOTA_FLOOR_PODS, value: \"5000\" }
    - { name: TENANT_QUOTA_FLOOR_SERVICES, value: \"2000\" }
    - { name: TENANT_QUOTA_FLOOR_PVCS, value: \"1000\" }
    - { name: TENANT_QUOTA_FLOOR_STORAGE_BYTES, value: \"109951162777600\" }"
  fi
  if [ -n "$ORCHARD_LIMITS" ]; then
    db_memory_env="$db_memory_env
    - { name: INSTANCE_RESOURCE_LIMITS_CHOICE, value: \"$ORCHARD_LIMITS\" }"
  fi

  local backup_method_env=
  if [ "$BARMAN_PLUGIN" = on ]; then
    backup_method_env="
    - { name: CNPG_BARMAN_PLUGIN, value: \"on\" }"
  fi

  local pull_policy_line=""
  if [ -n "$IMAGE_PULL_POLICY" ]; then
    pull_policy_line="
  pullPolicy: $IMAGE_PULL_POLICY"
  fi

  local gateway_line=""
  if [ "$HOST_DEFAULTS_VERSION" -lt 5 ] 2>/dev/null; then
    gateway_line="
  enabled: true"
  fi

  local image_block=""
  if [ -n "$IMAGE_TAG" ]; then
    image_block="  image:
    tag: $IMAGE_TAG"
  fi

  cat <<EOF
# Generated by install/install.sh. Edit and run 'orchardctl update' to apply.
createNamespace: false
# The round of new defaults this file already has. 'orchardctl update' applies
# later rounds to an older file and bumps this.
hostDefaults: $HOST_DEFAULTS_VERSION

image:
  registry: $IMAGE_REGISTRY
  repository: $IMAGE_REPOSITORY$pull_policy_line

signupMode: invite_only
datadog:
  enabled: false

frontend:
  replicas: 1$frontend_res
$image_block
  env:
    - { name: PUBLIC_HTTP_PORT, value: "$HTTP_PORT" }
    - { name: PUBLIC_HTTPS_PORT, value: "$HTTPS_PORT" }
    - { name: PUBLIC_OAUTH_PROVIDER, value: none }$frontend_tiny_env
$client_ip_block

server:
  replicas: 1$server_res
$image_block
  env:
    - { name: JWT_SECRET, value: "$JWT_SECRET" }
    - { name: SECRETS_ENCRYPTION_KEY, value: "$ENCRYPTION_KEY" }
    - { name: SSO_ENCRYPTION_KEY, value: "$SSO_KEY" }
    - { name: MCP_SERVICE_TOKEN, value: "$MCP_TOKEN" }
    - { name: APP_DOMAIN, value: $ORCHARD_APP_DOMAIN }$cname_env
    - { name: INSTALL_INGRESS_MODE, value: $INGRESS_MODE }
    - { name: CNPG_OPERATOR_NAMESPACE, value: cnpg-system }$backup_method_env
    - { name: PUBLIC_HTTP_PORT, value: "$HTTP_PORT" }
    - { name: PUBLIC_HTTPS_PORT, value: "$HTTPS_PORT" }
    - { name: FRONTEND_URL, value: $scheme://$ORCHARD_DOMAIN$url_suffix }
    - { name: SESSION_COOKIE_SECURE, value: "$cookie_secure" }
    - { name: MAX_CONCURRENT_BUILDS, value: "$MAX_BUILDS" }$db_memory_env
    - { name: DOCKER_REGISTRY_PUSH, value: zot.orchard.svc.cluster.local:5000 }
    - { name: DOCKER_REGISTRY_PULL, value: $REGISTRY_HOST }
    - { name: REGISTRY_HTTP_HOSTS, value: zot.orchard.svc.cluster.local:5000 }
    - { name: REGISTRY_PROJECT, value: orchard }
    - { name: REGISTRY_IMAGE_POLICY, value: enforce }
    - { name: HARBOR_USERNAME, value: $REGISTRY_USER }
    - { name: HARBOR_PASSWORD, value: "$REGISTRY_PASSWORD" }
    - { name: BUILDER_SCRATCH_STORAGE_CLASS, value: local-path }$server_tiny_env

protection:
  orchardLogin: true

tenant:
  # Traefik, not the HAProxy this project runs in network. Tenant namespaces
  # are default-deny, so the ingress controller has to be named or the ACME
  # HTTP-01 solver is unreachable and certificates never issue.
  ingressNamespaces: "traefik,orchard"
  storageClass: local-path
  ingressClass: traefik
  certClusterIssuer: "$CERT_ISSUER"$public_ip_pin

ingress:
  enabled: true
  host: $ORCHARD_DOMAIN
  extraHosts: $INGRESS_EXTRA_HOSTS
  entryPoints: [$entrypoint]
  tls:
    enabled: $tls_enabled$tls_issuer

gateway:$gateway_line
  http:
    appDomain: $ORCHARD_APP_DOMAIN

postgres:
  enabled: true
  instances: 1$postgres_res
  storage:
    size: 10Gi
    storageClass: local-path

redis:
  enabled: true
  storage: 1Gi
  storageClass: local-path$redis_res

builders:
  enabled: true
  platform: linux/$ARCH
  harbor:
    username: $REGISTRY_USER
    password: "$REGISTRY_PASSWORD"
    hosts:
      - zot.orchard.svc.cluster.local:5000
  httpRegistries:
    - zot.orchard.svc.cluster.local:5000
  # Builds are firewalled off from the rest of the cluster, so the registry they
  # push to has to be named or the push is refused. This installer runs zot in
  # the orchard namespace; the chart's defaults describe a different cluster.
  registryEgress:
    - namespace: orchard
      podLabels:
        app: zot
      ports:
        - port: 5000$builder_ingress_egress
  localCache:
    enabled: true
    size: ${BUILD_CACHE_GB}Gi
    storageClass: local-path
    evict:
      maxGiB: $BUILD_CACHE_GB

$(observability_values)

# Agents connect here. The chart derives MCP_BASE_URL, the frontend's
# PUBLIC_MCP_URL and the API it calls from the hostname below, so this is the
# whole of pointing an MCP client at this instance. Turn it off at install with
# --mcp false, or later with 'orchardctl mcp disable --apply'.
mcp:
  enabled: $ORCHARD_MCP
  # Stated rather than derived from the route: in tunnel mode Traefik answers
  # plaintext in-cluster while the world connects over https, and an OAuth
  # issuer that disagrees with the URL the client typed is rejected.
  url: $scheme://$ORCHARD_MCP_DOMAIN$url_suffix
  ingress:
    enabled: true
    host: $ORCHARD_MCP_DOMAIN
    entryPoints: [$entrypoint]
    tls:
      enabled: $tls_enabled$mcp_tls_issuer
  env:
    - { name: JWT_SECRET, value: "$JWT_SECRET" }
    - { name: MCP_SERVICE_TOKEN, value: "$MCP_TOKEN" }

certificates:
  enabled: false

# Sandboxed builds and tenant isolation need gVisor or Kata on the node.
# Follow install/README.md, then turn these on and run 'orchardctl update'.
tenantSandbox:
  enabled: false
builderSandbox:
  enabled: false
sandbox:
  enabled: false
EOF
}

backup_values() {
  local backup
  backup="$VALUES_FILE.$(date +%Y%m%d-%H%M%S).bak"
  if [ -e "$backup" ]; then backup="$backup.$$"; fi
  (umask 077; cp "$VALUES_FILE" "$backup") || return 1
  chmod 600 "$backup" || return 1
  printf '%s' "$backup"
}

refuse_values() {
  local backup
  backup=$(backup_values) || die "$1 The installer did not change the file, and it could not save a copy of it."
  die "$1 The installer stopped and didn't change the file. A copy is at $backup. Fix the problem, then run the installer again. Don't delete $VALUES_FILE: a new file means new secrets, and Orchard can't read data encrypted with the old ones."
}

require_readable_values() {
  if ! command -v yq >/dev/null 2>&1; then
    refuse_values "The installer needs yq to keep your settings in $VALUES_FILE, and yq isn't installed."
  fi
  if ! yq -e 'tag == "!!map"' "$VALUES_FILE" >/dev/null 2>&1; then
    refuse_values "The installer cannot read $VALUES_FILE, so it cannot keep your settings. Check that the file is valid YAML."
  fi
}

previous_answers_values() {
  (
    FLAGS_GIVEN=' ' ENV_AT_START=' ' MOVING_OFF_SSLIP=false
    keep_previous_answers
    mode=$(previous_ingress_mode)
    if [ -n "$mode" ]; then INGRESS_MODE=$mode; fi
    apply_mode_settings
    INGRESS_EXTRA_HOSTS=$(yq -o=json -I=0 '.ingress.extraHosts // []' "$VALUES_FILE")
    HTTP_SUFFIX='' HTTPS_SUFFIX=''
    if [ "$HTTP_PORT" != 80 ]; then HTTP_SUFFIX=":$HTTP_PORT"; fi
    if [ "$HTTPS_PORT" != 443 ]; then HTTPS_SUFFIX=":$HTTPS_PORT"; fi
    ORCHARD_PUBLIC_IP=$PREV_PUBLIC_IP
    ORCHARD_INGRESS_CNAME=$PREV_CNAME
    ORCHARD_LIMITS=''
    HOST_DEFAULTS_VERSION=$(reuse_value '.hostDefaults')
    HOST_DEFAULTS_VERSION=${HOST_DEFAULTS_VERSION:-0}
    render_values
  )
}

VALUES_FIELD=$'\037'
VALUES_ENV_LISTS='.. | select(path | join(".") | test("^(server|frontend|mcp)[.]env$"))'
VALUES_NODES='[.. | select(path | (length > 0 and all_c(tag == "!!str"))) | {"key": (path | join(".")), "value": {"path": path, "leaf": (tag != "!!map" or length == 0), "json": (. | to_json(0)), "node": .}}] | from_entries'

env_lists_by_name() {
  yq "($VALUES_ENV_LISTS | select(tag == \"!!seq\")) |= (.[] as \$entry ireduce ({}; .[\$entry.name] = [\$entry]))" "$1"
}

env_lists_restored() {
  yq "($VALUES_ENV_LISTS | select(tag == \"!!map\")) |= [.[] | .[]]" "$1"
}

three_way_values() {
  VALUES_PREVIOUS=$1 VALUES_BASELINE=$2 VALUES_GENERATED=$3 yq -n "
    load(strenv(VALUES_PREVIOUS)) as \$previous |
    load(strenv(VALUES_BASELINE)) as \$baseline |
    load(strenv(VALUES_GENERATED)) as \$generated |
    (\$baseline | $VALUES_NODES) as \$was |
    (\$generated | $VALUES_NODES) as \$now |
    (\$now | to_entries | map(select(.value.leaf and .value.json != (\$was[.key].json // \"\")) | .value)) as \$answered |
    (\$was | to_entries | map(select(\$now[.key] == null) | .value.path)) as \$cleared |
    (\$answered | .[] as \$at ireduce (\$generated * \$previous; setpath(\$at.path; \$at.node))) |
    delpaths(\$cleared) |
    del((.server.env, .frontend.env, .mcp.env) | (.K8S_INGRESS_CLASS, .K8S_STORAGE_CLASS, .PUBLIC_APP_DOMAIN))
  "
}

values_changes() {
  VALUES_PREVIOUS=$1 VALUES_MERGED=$2 VALUES_GENERATED=$3 yq -n "
    (load(strenv(VALUES_PREVIOUS)) | $VALUES_NODES) as \$before |
    (load(strenv(VALUES_MERGED)) | $VALUES_NODES) as \$after |
    (load(strenv(VALUES_GENERATED)) | $VALUES_NODES) as \$generated |
    [
      (\$after | to_entries | .[] | select(.value.leaf and .value.json != (\$before[.key].json // \"\")) | [\"change\", .key, (\$before[.key].json // \"-\"), .value.json]),
      (\$before | to_entries | .[] | select(.value.leaf and \$after[.key] == null) | [\"removed\", .key, \"-\", \"-\"]),
      (\$generated | to_entries | .[] | select(.value.leaf and .key != \"hostDefaults\" and \$before[.key] != null and .value.json != \$before[.key].json and \$before[.key].json == \$after[.key].json) | [\"kept\", .key, \"-\", \"-\"])
    ] | .[] | join(\"$VALUES_FIELD\")
  "
}

shown_value() {
  local value=$1
  case "$value" in
    '[{"name":'*'"value":'*'}]') value=${value#*\"value\":}; value=${value%\}\]} ;;
  esac
  value=${value#\"}
  value=${value%\"}
  printf '%s' "${value:-empty}"
}

hidden_value() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    *secret*|*token*|*passw*|*_pass*|*key*|*credential*) return 0 ;;
  esac
  return 1
}

show_values_changes() {
  local kind key old new kept='' any=false
  while IFS=$VALUES_FIELD read -r kind key old new; do
    [ -n "$kind" ] || continue
    if [ "$kind" = kept ]; then
      kept="${kept:+$kept, }$key"
      continue
    fi
    if [ "$any" = false ]; then
      note "These settings change in $VALUES_FILE:"
      any=true
    fi
    if [ "$kind" = removed ]; then
      note "  $key: removed"
    elif hidden_value "$key"; then
      if [ "$old" = - ]; then note "  $key: added, value hidden"; else note "  $key: changed, value hidden"; fi
    elif [ "$old" = - ]; then
      note "  $key: added as $(shown_value "$new")"
    else
      note "  $key: $(shown_value "$old") -> $(shown_value "$new")"
    fi
  done <<EOF
$1
EOF
  if [ "$any" = false ]; then note "No settings change in $VALUES_FILE."; fi
  if [ -n "$kept" ]; then note "These settings keep your value: $kept"; fi
}

merge_values() {
  local work round changes backup
  work=$(mktemp -d "$STATE_DIR/values-merge.XXXXXX") || refuse_values "The installer could not create a temporary folder in $STATE_DIR."

  round=$(reuse_value '.hostDefaults')
  case "$round" in
    ''|*[!0-9]*) ;;
    *) if [ "$round" -gt "$HOST_DEFAULTS_VERSION" ]; then HOST_DEFAULTS_VERSION=$round; fi ;;
  esac

  if ! {
    render_values > "$work/generated.raw" \
      && previous_answers_values > "$work/baseline.raw" \
      && env_lists_by_name "$VALUES_FILE" > "$work/previous" \
      && env_lists_by_name "$work/generated.raw" > "$work/generated" \
      && env_lists_by_name "$work/baseline.raw" > "$work/baseline" \
      && three_way_values "$work/previous" "$work/baseline" "$work/generated" > "$work/merged" \
      && env_lists_restored "$work/merged" > "$work/final" \
      && yq -e 'tag == "!!map"' "$work/final" >/dev/null \
      && changes=$(values_changes "$work/previous" "$work/merged" "$work/generated")
  } 2>/dev/null; then
    rm -rf "$work"
    refuse_values "The installer could not merge your settings into $VALUES_FILE."
  fi

  show_values_changes "$changes"

  case "$changes" in
    change*|*$'\n'change*|removed*|*$'\n'removed*)
      if ! backup=$(backup_values); then
        rm -rf "$work"
        die "The installer couldn't save a copy of $VALUES_FILE, so it didn't change the file."
      fi
      note "A copy of the previous file is at $backup."
      chmod 600 "$work/final"
      mv "$work/final" "$VALUES_FILE"
      ;;
    *)
      chmod 600 "$VALUES_FILE"
      ;;
  esac
  rm -rf "$work"
}

wait_for_cnpg_webhook() {
  local deadline=$((SECONDS + 300)) remaining addresses
  while [ "$SECONDS" -lt "$deadline" ]; do
    remaining=$((deadline - SECONDS))
    [ "$remaining" -gt 0 ] || break
    if addresses=$(kubectl -n cnpg-system get endpoints/cnpg-webhook-service \
      -o jsonpath='{.subsets[*].addresses[*].ip}' \
      --request-timeout="$((remaining < 5 ? remaining : 5))s") && [ -n "$addresses" ]; then
      return 0
    fi
    remaining=$((deadline - SECONDS))
    if [ "$remaining" -gt 0 ]; then
      sleep "$((remaining < 2 ? remaining : 2))"
    fi
  done
  printf 'Timed out waiting for the CloudNativePG webhook endpoint\n' >&2
  return 1
}

release_unbound_volume() {
  local sts=$1 claim=$2 want=$3 live phase
  live=$(kubectl -n orchard-metrics get statefulset "$sts" --ignore-not-found \
    -o jsonpath='{.metadata.name}|{.spec.volumeClaimTemplates[0].spec.storageClassName}') || return 0
  [ -n "${live%%|*}" ] || return 0
  [ "${live#*|}" != "$want" ] || return 0
  phase=$(kubectl -n orchard-metrics get pvc "$claim" --ignore-not-found -o jsonpath='{.status.phase}') || return 0
  case "$phase" in
    ''|Pending)
      kubectl -n orchard-metrics delete statefulset "$sts" --wait=true >/dev/null
      [ -z "$phase" ] || kubectl -n orchard-metrics delete pvc "$claim" --wait=false >/dev/null
      ;;
  esac
}

release_unbound_volumes() {
  release_unbound_volume victorialogs data-victorialogs-0 local-path
  release_unbound_volume victoriametrics data-victoriametrics-0 local-path
}

apply_chart() {
  local attempt output
  for attempt in 1 2 3 4 5; do
    if output=$(helm "$@" 2>&1); then
      printf '%s\n' "$output"
      return 0
    fi
    printf '%s\n' "$output" >&2
    case "$output" in
      *"failed calling webhook"*) ;;
      *) return 1 ;;
    esac
    [ "$attempt" -lt 5 ] || return 1
    sleep 15
    wait_for_cnpg_webhook || return 1
  done
}

save_install_settings() {
  local pending="$STATE_DIR/settings-pending" args=(seed) force=false save_ip=false save_cname=false
  if [ -f "$pending" ]; then
    save_ip=true
    save_cname=true
  else
    if [ "$ORCHARD_PUBLIC_IP" != "$PREV_PUBLIC_IP" ]; then save_ip=true; force=true; fi
    if [ "$ORCHARD_INGRESS_CNAME" != "$PREV_CNAME" ]; then save_cname=true; force=true; fi
  fi
  if [ -n "$(reuse_value '.tenant.publicIp')" ]; then save_ip=false; fi
  if [ -n "$(reuse_secret INGRESS_CNAME)" ]; then save_cname=false; fi

  if [ "$force" = true ]; then args+=(--force); fi
  if [ "$save_ip" = true ] && { [ "$force" = true ] || [ -n "$ORCHARD_PUBLIC_IP" ]; }; then
    args+=(--public-ip "$ORCHARD_PUBLIC_IP")
  fi
  if [ "$save_cname" = true ] && { [ "$force" = true ] || [ -n "$ORCHARD_INGRESS_CNAME" ]; }; then
    args+=(--cname "$ORCHARD_INGRESS_CNAME")
  fi

  if [ "${#args[@]}" -gt 1 ] && [ "${args[*]}" != "seed --force" ]; then
    if ! kubectl -n orchard exec deploy/server -- node dist/scripts/install-settings.js "${args[@]}" >/dev/null 2>&1; then
      warn "couldn't save the public IP and custom domains target. Set them under Instance admin > Configuration."
      return 0
    fi
    info "saved. Change the public IP and custom domains target under Instance admin > Configuration."
  fi
  rm -f "$pending"
}

dashboard_cert_ready() {
  [ "$(kubectl -n orchard get certificate orchard-tls \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = True ]
}

certificate_problem() {
  local reasons
  reasons=$(kubectl get challenges -A \
    -o jsonpath='{range .items[*]}{.status.reason}{"\n"}{end}' 2>/dev/null || true)
  reasons="$reasons $(kubectl get orders -A \
    -o jsonpath='{range .items[*]}{.status.reason}{"\n"}{end}' 2>/dev/null || true)"
  case "$reasons" in
    *'Timeout during connect'*|*'Connection refused'*|*'connection refused'*|*'Connection reset'*|*firewall*)
      printf firewall
      ;;
    *NXDOMAIN*|*'No valid IP addresses'*|*'no valid A records'*|*'DNS problem'*|*'SERVFAIL'*)
      printf dns
      ;;
    *rateLimited*|*'too many certificates'*|*'rate limit'*)
      printf ratelimit
      ;;
  esac
}

wait_for_dashboard_cert() {
  local tries=0
  until dashboard_cert_ready; do
    tries=$((tries + 1))
    [ "$tries" -lt 36 ] || return 0
    sleep 5
  done
}

install_orchard() {
  step

  if [ "$PREVIOUS_INSTALL" = false ]; then : > "$STATE_DIR/settings-pending"; fi

  kubectl create namespace network >/dev/null 2>&1 || true

  local args=(upgrade --install orchard "$CHART_REF"
    --namespace orchard --create-namespace)
  if [ -f "$STATE_DIR/images.yaml" ]; then args+=(-f "$STATE_DIR/images.yaml"); fi
  args+=(-f "$VALUES_FILE" --timeout 20m)
  if [ -n "$ORCHARD_VERSION" ]; then args+=(--version "$ORCHARD_VERSION"); fi

  run_step "CloudNativePG webhook" 1m wait_for_cnpg_webhook
  run_step "checking existing volumes" 10s release_unbound_volumes
  if helm version --short 2>/dev/null | grep -q '^v4\.'; then args+=(--server-side=false); fi
  run_step "applying the chart" 40s apply_chart "${args[@]}"
  run_step "postgres" 3m kubectl -n orchard wait --for=condition=Ready \
    cluster.postgresql.cnpg.io/orchard-db --timeout=10m
  run_step "redis" 30s kubectl -n orchard rollout status deploy/redis --timeout=5m
  run_step "the api" 3m kubectl -n orchard rollout status deploy/server --timeout=10m
  run_step "the web app" 1m kubectl -n orchard rollout status deploy/frontend --timeout=5m
  if [ "$ORCHARD_MCP" = true ]; then
    run_step "the agent endpoint" 1m kubectl -n orchard rollout status deploy/mcp --timeout=5m
  fi
  save_install_settings
  if [ "$USE_TLS" = true ]; then
    if [ -n "$DNS_PENDING" ] || [ "$DNS_SKIPPED" = true ]; then
      info "not waiting for the dashboard certificate, because DNS isn't finished"
    else
      run_step "giving the dashboard certificate time to issue" 1m wait_for_dashboard_cert
    fi
  fi
}

write_host_env() {
  local env_file="$STATE_DIR/env" k3s_updates=on kept=''
  if [ -n "$K3S_VERSION" ] || grep -qs '^ORCHARD_K3S_UPDATES=off$' "$env_file"; then
    k3s_updates=off
  fi
  if [ -f "$env_file" ]; then
    kept=$(grep -vE '^(ORCHARD_VALUES|ORCHARD_CHART|ORCHARD_NAMESPACE|ORCHARD_K3S_UPDATES|ORCHARD_ALLOW_UNSIGNED_COMMANDS)=' "$env_file" | grep -v '^[[:space:]]*$' || true)
  fi
  mkdir -p "$STATE_DIR"
  (
    umask 077
    {
      printf 'ORCHARD_VALUES=%s\n' "$VALUES_FILE"
      printf 'ORCHARD_CHART=%s\n' "$CHART_REF"
      printf 'ORCHARD_NAMESPACE=orchard\n'
      printf 'ORCHARD_K3S_UPDATES=%s\n' "$k3s_updates"
      printf 'ORCHARD_ALLOW_UNSIGNED_COMMANDS=%s\n' "$(unsigned_commands_allowed)"
      if [ -n "$kept" ]; then printf '%s\n' "$kept"; fi
    } > "$env_file.tmp"
  )
  mv -f "$env_file.tmp" "$env_file"
  chmod 600 "$env_file"
}

install_updater() {
  step

  # Runtime paths for the host commands, which ship as static files inside the
  # server image rather than being generated here with these baked in.
  write_host_env

  # The commands run unrendered, so this is a plain copy: pull the sync script
  # out of the image and let it install the rest.
  local boot
  boot=$(mktemp)
  if kubectl -n orchard exec deploy/server -- cat /app/hostbin/orchard-sync-commands > "$boot" 2>/dev/null \
     && [ -s "$boot" ] && bash -n "$boot" 2>/dev/null \
     && verify_bootstrap "$boot"; then
    install -m 0755 "$boot" /usr/local/bin/orchard-sync-commands
    rm -f "$boot"
    if ORCHARD_STATE_DIR="$STATE_DIR" orchard-sync-commands >/dev/null; then
      info "host commands installed (orchardctl)"
    else
      warn "couldn't install the host commands; run orchard-sync-commands later"
    fi
  else
    rm -f "$boot"
    warn "couldn't read the host commands from the server pod; skipping"
  fi

  if [ "$ORCHARD_UPDATE_POLICY" = automatic ]; then
    cat > /etc/systemd/system/orchard-update.service <<'EOF'
[Unit]
Description=Update Orchard
[Service]
Type=oneshot
ExecStart=/usr/local/bin/orchard-update
EOF
    cat > /etc/systemd/system/orchard-update.timer <<'EOF'
[Unit]
Description=Nightly Orchard update
[Timer]
OnCalendar=daily
RandomizedDelaySec=2h
Persistent=true
[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now orchard-update.timer >/dev/null
    info "nightly updates enabled (systemctl disable orchard-update.timer to stop)"
  else
    systemctl disable --now orchard-update.timer >/dev/null 2>&1 || true
    info "run 'sudo orchardctl update' to upgrade"
  fi
}

sandboxes_on() {
  [ "$(yq -r '.tenantSandbox.enabled == true and .builderSandbox.enabled == true' "$VALUES_FILE" 2>/dev/null)" = true ]
}

backup_method_notice() {
  if [ "$BARMAN_PLUGIN" = on ]; then
    note "Database backups: Barman Cloud plugin"
    return 0
  fi
  printf '\n  %sBefore CloudNativePG 1.31%s\n' "$C_BOLD" "$C_RESET"
  if [ "$IN_TREE_BACKUPS" -gt 0 ]; then
    note "$IN_TREE_BACKUPS database(s) back up with CloudNativePG's built-in Barman Cloud"
  else
    note "New databases back up with CloudNativePG's built-in Barman Cloud"
  fi
  note "support, which CloudNativePG 1.31 removes. This run did not change that."
  note "To move them to the Barman Cloud plugin, run:"
  note "sudo orchardctl env set CNPG_BARMAN_PLUGIN on --apply"
  note "Then turn on Instance admin > Configuration > Databases >"
  note "Move backups to the Barman Cloud plugin."
  note "https://docs.orchard.hackclub.com/operate/upgrades/#move-database-backups-to-the-barman-cloud-plugin"
}

sandbox_notice() {
  sandboxes_on && return 0
  printf '\n  %sBefore anyone else deploys here%s\n' "$C_BOLD" "$C_RESET"
  note "This install is not safe for tenants you don't trust. Without the sandboxes,"
  note "code deployed here shares this machine's kernel with your data and secrets."
  note "Turn on tenantSandbox and builderSandbox first:"
  note "https://github.com/hackclub/orchard/blob/main/install/README.md"
}

summary() {
  local scheme=https suffix=$HTTPS_SUFFIX
  if [ "$USE_TLS" = false ]; then
    if [ "$INGRESS_MODE" != tunnel ]; then scheme=http; suffix=$HTTP_SUFFIX; fi
  fi
  if [ "$INGRESS_MODE" = tunnel ]; then suffix=''; fi

  step

  build_dns_records
  dns_check_all true

  local cert_pending=false headline='Orchard is ready' line problem tunnel_tls_failed=''
  if [ "$USE_TLS" = true ] && ! dashboard_cert_ready; then cert_pending=true; fi
  if [ "$INGRESS_MODE" = tunnel ] && [ -z "$DNS_PENDING" ]; then tunnel_tls_failed=$(tunnel_tls_failures); fi
  if [ -n "$DNS_PENDING" ] || [ "$cert_pending" = true ] || [ -n "$tunnel_tls_failed" ]; then headline='Orchard is installed'; fi

  printf '\n'
  box_top
  pad_line ""
  pad_line "$C_BRIGHT$C_BOLD  $headline$C_RESET$C_GREY   took $(elapsed)$C_RESET"
  pad_line ""
  pad_line "  ${C_GREY}Dashboard${C_RESET}  $scheme://$ORCHARD_DOMAIN$suffix"
  pad_line "  ${C_GREY}Your apps${C_RESET}  *.$ORCHARD_APP_DOMAIN$HTTPS_SUFFIX"
  if [ "$ORCHARD_MCP" = true ]; then
    pad_line "  ${C_GREY}Agents${C_RESET}     $scheme://$ORCHARD_MCP_DOMAIN$suffix"
  fi
  pad_line ""
  box_bottom

  printf '\n  %sConfigured%s\n' "$C_BOLD" "$C_RESET"
  note "Public IP: ${ORCHARD_PUBLIC_IP:-not set}"
  note "Custom domains target: ${ORCHARD_INGRESS_CNAME:-not set}"
  if [ "$ORCHARD_MCP" = false ]; then note "MCP endpoint: off"; fi
  if [ "$INGRESS_MODE" = public ]; then note "Let's Encrypt email: ${ORCHARD_ACME_EMAIL:-none}"; fi
  note "Updates: $ORCHARD_UPDATE_POLICY"
  if [ "$S3_READY" = true ]; then
    note "Storage: $ORCHARD_S3_BUCKET at $ORCHARD_S3_ENDPOINT"
  elif [ "$ORCHARD_OBJECT_STORAGE" = true ]; then
    note "Storage: on this server. If you lose the server, you lose the backups."
  fi
  backup_method_notice

  if [ -n "$DNS_PENDING" ] || [ "$cert_pending" = true ] || [ -n "$tunnel_tls_failed" ]; then
    printf '\n  %sStill pending%s\n' "$C_BOLD" "$C_RESET"
    if [ -n "$tunnel_tls_failed" ]; then
      note "HTTPS: Cloudflare refused the connection to $tunnel_tls_failed"
      note "The tunnel can be healthy and this still happens. The usual cause is a name more than"
      note "one level under your zone, which the free certificate doesn't cover. Use names directly"
      note "under the zone, or add Advanced Certificate Manager in Cloudflare."
    fi
    if [ -n "$DNS_PENDING" ]; then
      while IFS= read -r line; do
        if [ -n "$line" ]; then note "DNS: $line"; fi
      done <<EOF
$DNS_PENDING
EOF
      note "Nothing opens at these names until the records are right."
    fi
    if [ "$cert_pending" = true ]; then
      note "Certificate: not issued yet, so browsers warn on the dashboard."
      problem=$(certificate_problem)
      case "$problem" in
        firewall)
          note "Let's Encrypt couldn't connect to this machine. $(firewall_hint)"
          ;;
        dns)
          note "Let's Encrypt couldn't find the DNS records for it."
          ;;
        ratelimit)
          note "Let's Encrypt is rate limiting this domain. That clears on its own."
          ;;
      esac
      if is_sslip "$ORCHARD_DOMAIN"; then
        note "All sslip.io users share one Let's Encrypt limit. Your own domain avoids it."
      fi
      note "cert-manager retries on its own, first after about an hour. To see why it hasn't"
      note "issued yet: sudo kubectl -n orchard describe certificate orchard-tls"
    fi
  fi

  printf '\n  %sSign in%s\n' "$C_BOLD" "$C_RESET"
  note "Open this link to create the first account. You don't need an email"
  note "to sign in with this link."
  if [ -n "$DNS_PENDING" ]; then
    note "It opens once the dashboard's DNS record is right."
  fi
  printf '\n'
  if claim_link=$(orchard-claim 2>/dev/null | grep -E '^\s+http'); then
    printf '      %s%s%s\n' "$C_BRIGHT" "$(echo "$claim_link" | tr -d ' ')" "$C_RESET"
  else
    printf '      %ssudo orchardctl claim%s\n' "$C_BRIGHT" "$C_RESET"
  fi
  printf '\n'
  note "Setup then asks for a passkey or a password. With no email configured there"
  note "are no sign-in codes. If you get locked out, run: sudo orchardctl login"

  sandbox_notice

  printf '\n  %sNext, in the dashboard%s\n' "$C_BOLD" "$C_RESET"
  note "Setup walks you through what is left: your organization, the GitHub App,"
  note "storage, resource limits and email. Then deploy an app:"
  note "https://docs.orchard.hackclub.com/start/first-deploy/"

  printf '\n  %sChange these later%s\n' "$C_BOLD" "$C_RESET"
  note "Public IP, custom domains target, SMTP, storage: Instance admin > Configuration"
  note "MCP hostname: sudo orchardctl mcp enable <host> --apply"
  if is_sslip "$ORCHARD_DOMAIN"; then
    note "Your own domain: run the installer again with --domain <host>"
  else
    note "Dashboard or apps domain, Let's Encrypt email: run the installer again"
  fi
  if [ "$ORCHARD_UPDATE_POLICY" = automatic ]; then
    note "Updates run nightly. To update now: sudo orchardctl update"
  else
    note "Updates: sudo orchardctl update. For nightly updates, run the installer with --updates automatic"
  fi
  printf '\n'

  if [ "$INGRESS_MODE" = tunnel ]; then
    warn "Tunnel mode carries HTTP only, so public databases and raw TCP ports are off."
  fi
  warn "Builds share this machine's kernel. Only give build access to people you trust."
  printf '\n'
}

main() {
  parse_args "$@"
  load_previous_answers
  settle_image_tag
  settle_pull_policy
  check_image_tag

  if [ "$ASSUME_YES" != true ] && ! open_prompt_fd; then
    warn "$PROMPT_BLOCKED"
    prompt_hint
    PROMPT_HINT_SHOWN=true
    # The mode question is the first one and it is unconditional, so there is no
    # point walking through the machine checks to arrive at a question that
    # cannot be answered.
    if [ -z "$ORCHARD_INGRESS_MODE" ]; then
      die "stopping before the first question; nothing has been installed"
    fi
  fi
  local i=0
  REMAINING=0
  while [ "$i" -lt "$STEP_TOTAL" ]; do
    REMAINING=$((REMAINING + PLAN_COSTS[i]))
    i=$((i + 1))
  done

  banner
  show_plan
  preflight
  detect_network
  require_ipv4
  collect_answers
  dns_step
  START_TS=$(date +%s)
  size_workloads
  install_k3s
  ensure_helm
  ensure_yq
  install_operators
  install_registry
  install_tunnel
  write_values
  install_orchard
  install_updater
  apply_s3_storage
  summary
}

if [ "${ORCHARD_LIB_ONLY:-}" != "1" ]; then
  main "$@"
fi
