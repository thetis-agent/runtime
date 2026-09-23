#!/usr/bin/env bash
# Thetis installer. One command puts a whole installation on a machine:
#
#     curl -fsSL https://raw.githubusercontent.com/thetis-agent/runtime/main/deploy/install.sh | bash
#
# What it does, in order: checks the host, installs the OS packages the fence needs (bubblewrap,
# slirp4netns, git, xz), puts Node 24 under ~/.local, clones runtime + packages into <prefix>/runtime,
# builds, writes .env and thetis.config.json with the data directory at <prefix>/data, creates the
# first admin, installs and starts the systemd unit with this host's real paths, and proves the door
# answers. Run it again to update: it pulls, rebuilds, reloads the running daemon's configuration and
# workspaces, and asks the daemon for a new process only when the daemon itself changed.
#
# It runs as the person who will operate Thetis, never as root. sudo is asked for exactly three things:
# the OS packages, the prefix under /opt, and the systemd unit. Everything else is theirs.
# `install.sh --help` lists the options and the environment it reads.
set -euo pipefail

# ---------------------------------------------------------------------------------------------------
# Terminal: colour, glyphs and the few drawing routines everything below is made of.
# ---------------------------------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then TTY=1; else TTY=0; fi
if [ "$TTY" = 1 ] && { [ "${COLORTERM:-}" = "truecolor" ] || [ "${COLORTERM:-}" = "24bit" ]; }; then RGB=1; else RGB=0; fi
if [ "$TTY" = 1 ]; then
  ESC=$'\033'
  RESET="${ESC}[0m"; BOLD="${ESC}[1m"; DIM="${ESC}[2m"
  RED="${ESC}[31m"; GREEN="${ESC}[32m"; YELLOW="${ESC}[33m"; CYAN="${ESC}[36m"
  HIDE="${ESC}[?25l"; SHOW="${ESC}[?25h"; CLEAR="${ESC}[2K"
else
  ESC=""; RESET=""; BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; HIDE=""; SHOW=""; CLEAR=""
fi
OK="${GREEN}✔${RESET}"; BAD="${RED}✖${RESET}"; WARN="${YELLOW}▲${RESET}"; DOT="${DIM}◦${RESET}"; ARROW="${CYAN}›${RESET}"
COLS=$( { [ "$TTY" = 1 ] && tput cols 2>/dev/null; } || echo 80)
[ "$COLS" -gt 100 ] && COLS=100
# The glyph counts below are characters, not bytes.
if [ "$(LC_ALL=C.UTF-8 bash -c 'x="●"; echo ${#x}' 2>/dev/null)" = 1 ]; then export LC_ALL=C.UTF-8; fi
rep() { local n=$2; [ "$n" -gt 0 ] 2>/dev/null || return 0; printf '%*s' "$n" '' | sed "s/ /$1/g"; }

# A colour on the sea gradient the banner and the frames use: teal at 0, deep blue at 100, in 24-bit
# where the terminal has it, else the nearest of the 256.
sea() { # sea <0..100>
  local t=$1
  if [ "$RGB" = 1 ]; then
    local r=$(( 40 + (30 - 40) * t / 100 )) g=$(( 220 + (110 - 220) * t / 100 )) b=$(( 200 + (255 - 200) * t / 100 ))
    printf '%s[38;2;%d;%d;%dm' "$ESC" "$r" "$g" "$b"
  elif [ "$TTY" = 1 ]; then
    local steps=(51 50 44 38 39 33 33 27); printf '%s[38;5;%dm' "$ESC" "${steps[$(( t * 7 / 100 ))]}"
  fi
}

banner() {
  [ "$TTY" = 1 ] || { echo "Thetis installer"; return; }
  local rows=(
    '████████╗██╗  ██╗███████╗████████╗██╗███████╗'
    '╚══██╔══╝██║  ██║██╔════╝╚══██╔══╝██║██╔════╝'
    '   ██║   ███████║█████╗     ██║   ██║███████╗'
    '   ██║   ██╔══██║██╔══╝     ██║   ██║╚════██║'
    '   ██║   ██║  ██║███████╗   ██║   ██║███████║'
    '   ╚═╝   ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝╚══════╝'
  )
  echo
  local i=0
  for row in "${rows[@]}"; do printf '   %s%s%s\n' "$(sea $(( i * 20 )))" "$row" "$RESET"; i=$((i + 1)); done
  printf '   %s%s%s\n' "$(sea 100)" "$(rep ≈ 46)" "$RESET"
  printf '   %sa recursive language model service · installer%s\n\n' "$DIM" "$RESET"
}

note() { printf '   %s %s\n' "$DOT" "$*"; }
good() { printf '   %s %s\n' "$OK" "$*"; }
warn() { printf '   %s %s\n' "$WARN" "$*"; }
die() {
  printf '\n   %s %s%s%s\n\n' "$BAD" "$RED" "$*" "$RESET" >&2
  if [ -n "${LOG:-}" ] && [ -s "$LOG" ]; then printf '   %slast lines of %s%s\n' "$DIM" "$LOG" "$RESET" >&2; tail -n 25 "$LOG" | sed 's/^/   │ /' >&2; fi
  printf '%s' "$SHOW"; exit 1
}
section() { echo; printf ' %s◆%s %s%s%s\n' "$(sea 30)" "$RESET" "$BOLD" "$*" "$RESET"; }

# A boxed paragraph; each argument is one line.
box() {
  local w=$((COLS - 6)) line plain pad
  printf '   %s╭%s╮%s\n' "$(sea 0)" "$(rep ─ $w)" "$RESET"
  for line in "$@"; do
    plain=$(printf '%s' "$line" | sed 's/\x1b\[[0-9;]*m//g')
    pad=$(( w - 1 - ${#plain} )); [ "$pad" -lt 0 ] && pad=0
    printf '   %s│%s %s%*s%s│%s\n' "$(sea 50)" "$RESET" "$line" "$pad" '' "$(sea 50)" "$RESET"
  done
  printf '   %s╰%s╯%s\n' "$(sea 100)" "$(rep ─ $w)" "$RESET"
}

# run <label> <command...>: a spinner while it runs, its output in the log, a tick with the time taken.
STEP=0; STEPS=8
run() {
  local label=$1; shift
  STEP=$((STEP + 1))
  local tag; tag=$(printf '%s[%d/%d]%s' "$DIM" "$STEP" "$STEPS" "$RESET")
  local start=$SECONDS
  { echo; echo "=== [$STEP/$STEPS] $label"; echo "\$ $*"; } >>"$LOG"
  if [ "$TTY" = 1 ]; then
    printf '%s' "$HIDE"
    "$@" >>"$LOG" 2>&1 &
    local pid=$! frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r%s   %s%s%s %s %s' "$CLEAR" "$(sea $(( (i * 10) % 100 )))" "${frames:$((i % 10)):1}" "$RESET" "$tag" "$label"
      i=$((i + 1)); sleep 0.08
    done
    local code=0; wait "$pid" || code=$?
    printf '\r%s' "$CLEAR"
    if [ "$code" = 0 ]; then
      printf '   %s %s %s %s(%ss)%s\n' "$OK" "$tag" "$label" "$DIM" "$((SECONDS - start))" "$RESET"
    else
      printf '   %s %s %s\n%s' "$BAD" "$tag" "$label" "$SHOW"
      die "$label failed (exit $code)"
    fi
    printf '%s' "$SHOW"
  else
    printf '   • [%d/%d] %s\n' "$STEP" "$STEPS" "$label"
    "$@" >>"$LOG" 2>&1 || die "$label failed"
  fi
}
skip() { STEP=$((STEP + 1)); printf '   %s %s[%d/%d]%s %s\n' "$DOT" "$DIM" "$STEP" "$STEPS" "$RESET" "$*"; }

# ask <var> <prompt> <default>: reads from the terminal even when the script itself came in on stdin.
ask() {
  local var=$1 prompt=$2 default=${3:-} answer=""
  if [ "$YES" = 1 ] || [ ! -r /dev/tty ]; then printf -v "$var" '%s' "$default"; return; fi
  printf '   %s %s%s: ' "$ARROW" "$prompt" "${default:+ ${DIM}[$default]${RESET}}" >/dev/tty
  IFS= read -r answer </dev/tty || true
  printf -v "$var" '%s' "${answer:-$default}"
}
ask_secret() {
  local var=$1 prompt=$2 answer=""
  if [ "$YES" = 1 ] || [ ! -r /dev/tty ]; then printf -v "$var" '%s' ""; return; fi
  printf '   %s %s %s(hidden; empty to skip)%s: ' "$ARROW" "$prompt" "$DIM" "$RESET" >/dev/tty
  IFS= read -r -s answer </dev/tty || true
  echo >/dev/tty
  printf -v "$var" '%s' "$answer"
}
confirm() { [ "$YES" = 1 ] && return 0; local a; ask a "$1 (y/N)" "n"; case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac; }

# download <url> <file>: a progress bar when the size is known and there is a terminal to draw it on.
download() {
  local url=$1 out=$2
  if [ "$TTY" != 1 ]; then curl -fsSL -o "$out" "$url"; return; fi
  local total; total=$(curl -fsSLI "$url" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-length:"{n=$2} END{print n+0}')
  curl -fsSL -o "$out" "$url" &
  local pid=$! width=$((COLS - 32)) have pct filled
  printf '%s' "$HIDE"
  while kill -0 "$pid" 2>/dev/null; do
    have=$(stat -c %s "$out" 2>/dev/null || echo 0)
    if [ "$total" -gt 0 ]; then pct=$((have * 100 / total)); else pct=0; fi
    filled=$((width * pct / 100))
    printf '\r%s     %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$CLEAR" "$(sea "$pct")" "$(rep █ "$filled")" "$DIM" "$(rep ░ $((width - filled)))" "$RESET" "$pct" "$DIM" "$((have / 1048576))" "$((total / 1048576))" "$RESET"
    sleep 0.1
  done
  local code=0; wait "$pid" || code=$?
  printf '\r%s%s' "$CLEAR" "$SHOW"
  return "$code"
}

# ---------------------------------------------------------------------------------------------------
# Arguments and environment.
# ---------------------------------------------------------------------------------------------------
usage() {
  cat <<'USAGE'
Thetis installer

  curl -fsSL https://raw.githubusercontent.com/thetis-agent/runtime/main/deploy/install.sh | bash -s -- [options]

Options
  --prefix DIR     install root; runtime at DIR/runtime, data at DIR/data   (default /opt/zero)
  --ref REF        branch, tag or commit of thetis-agent/runtime to install (default main)
  --admin ID       the first admin's user id                                (default $USER)
  --host ADDR      the address the door listens on                          (default 127.0.0.1)
  --port N         the port the door listens on                             (default 8777)
  --no-service     do not install the systemd unit; print how to start by hand
  --no-deps        do not touch OS packages
  -y, --yes        never prompt; take defaults and environment variables
  --uninstall      stop and remove the unit and the launcher; the data and checkout stay
  -h, --help

Environment
  OPENROUTER_API_KEY      the model provider key (asked for when missing)
  THETIS_ADMIN_PASSWORD   the admin's first password (generated and shown when unset)
  THETIS_PREFIX, THETIS_REF, THETIS_REPO, THETIS_ADMIN, THETIS_DOOR_HOST, THETIS_DOOR_PORT
  NODE_VERSION            an exact Node version, e.g. 24.18.0 (default: the latest 24.x)
  THETIS_INSTALL_LOG      where the step output goes (default: a file under /tmp)
USAGE
}
PREFIX=${THETIS_PREFIX:-/opt/zero}
REF=${THETIS_REF:-main}
REPO=${THETIS_REPO:-https://github.com/thetis-agent/runtime.git}
ADMIN=${THETIS_ADMIN:-${USER:-$(id -un)}}
DOOR_HOST=${THETIS_DOOR_HOST:-127.0.0.1}
DOOR_PORT=${THETIS_DOOR_PORT:-8777}
SERVICE=1; DEPS=1; YES=0; UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX=$2; shift ;;
    --prefix=*) PREFIX=${1#*=} ;;
    --ref) REF=$2; shift ;;
    --ref=*) REF=${1#*=} ;;
    --admin) ADMIN=$2; shift ;;
    --admin=*) ADMIN=${1#*=} ;;
    --host) DOOR_HOST=$2; shift ;;
    --host=*) DOOR_HOST=${1#*=} ;;
    --port) DOOR_PORT=$2; shift ;;
    --port=*) DOOR_PORT=${1#*=} ;;
    --no-service) SERVICE=0 ;;
    --no-deps) DEPS=0 ;;
    -y|--yes) YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
ROOT="$PREFIX/runtime"
HOME_DIR="$PREFIX/data"
UNIT=thetis-runtime.service
UNIT_PATH=/etc/systemd/system/$UNIT
LAUNCHER="$HOME/.local/bin/thetis"
LOG=${THETIS_INSTALL_LOG:-$(mktemp -t thetis-install.XXXXXX.log)}
trap 'printf "%s" "$SHOW"' EXIT

banner

# ---------------------------------------------------------------------------------------------------
# Who is running this, and can they get root for the three things that need it.
# ---------------------------------------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ] && [ -z "${THETIS_INSTALL_ALLOW_ROOT:-}" ]; then
  die "do not run this as root or with sudo: Thetis runs as the person operating it, and the installer asks for sudo itself when it needs it. (THETIS_INSTALL_ALLOW_ROOT=1 overrides, for a container that has nobody else.)"
fi
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null; then SUDO="sudo -n"
  elif [ -r /dev/tty ] && [ "$YES" = 0 ]; then
    note "sudo is needed for the OS packages, $PREFIX and the systemd unit"
    if sudo -v </dev/tty; then SUDO="sudo"; fi
  fi
fi
if [ -z "$SUDO" ] && [ "$(id -u)" -ne 0 ]; then
  warn "no sudo: skipping OS packages and the service, and installing under your home"
  DEPS=0; SERVICE=0
  case "$PREFIX" in /opt/*) PREFIX="$HOME/.thetis-agent"; ROOT="$PREFIX/runtime"; HOME_DIR="$PREFIX/data" ;; esac
fi

# ---------------------------------------------------------------------------------------------------
# --uninstall: the unit and the launcher go; the checkout and the data are left where they are.
# ---------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  section "Uninstall"
  note "this removes the service and the launcher; $ROOT and $HOME_DIR stay"
  confirm "Continue" || exit 0
  if [ -f "$UNIT_PATH" ]; then
    $SUDO systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
    $SUDO rm -f "$UNIT_PATH" && $SUDO systemctl daemon-reload && good "removed $UNIT"
  else note "no unit at $UNIT_PATH"; fi
  if [ -f "$LAUNCHER" ]; then rm -f "$LAUNCHER" && good "removed $LAUNCHER"; fi
  echo; note "to remove everything:  rm -rf $ROOT $HOME_DIR"; echo
  exit 0
fi

# ---------------------------------------------------------------------------------------------------
# Preflight: what this host is and what it has.
# ---------------------------------------------------------------------------------------------------
section "Checking this machine"
case "$(uname -s)" in Linux) ;; *) die "Thetis needs Linux: the fence is bubblewrap and cgroup v2. $(uname -s) cannot host it." ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported architecture: $(uname -m)" ;; esac
PRETTY_NAME=""; . /etc/os-release 2>/dev/null || true
good "$(uname -s) $(uname -m) · ${PRETTY_NAME:-unknown distribution} · kernel $(uname -r)"
PKG=""
for candidate in apt-get dnf yum pacman zypper apk; do if command -v "$candidate" >/dev/null 2>&1; then PKG=$candidate; break; fi; done
if [ -n "$PKG" ]; then note "package manager: $PKG"; else warn "no known package manager; OS packages are yours to install"; fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then good "systemd is running"; else
  [ "$SERVICE" = 1 ] && warn "systemd is not running here; the service will not be installed"; SERVICE=0; fi
if [ "$(stat -f -c %T /sys/fs/cgroup 2>/dev/null)" = "cgroup2fs" ]; then good "cgroup v2"; else warn "no cgroup v2: fences run without resource limits"; fi
if [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 0)" -gt 0 ]; then good "user namespaces are on"; else warn "user namespaces are off (user.max_user_namespaces=0): the fence will fall back to no sandbox"; fi
if [ -S /var/run/docker.sock ]; then
  if docker info >/dev/null 2>&1; then good "docker is usable: fences get the host's socket (fence.docker auto)"; else note "docker socket present but not usable by $(id -un); fences get no docker"; fi
else note "no docker; fences get none (optional)"; fi
existing_wd=$(systemctl show -p WorkingDirectory --value "$UNIT" 2>/dev/null || true)

# ---------------------------------------------------------------------------------------------------
# Choices, from the terminal or from the environment.
# ---------------------------------------------------------------------------------------------------
section "Choices"
ask PREFIX "Install prefix" "$PREFIX"; ROOT="$PREFIX/runtime"; HOME_DIR="$PREFIX/data"
if [ "$SERVICE" = 1 ] && [ -n "$existing_wd" ] && [ "$existing_wd" != "$ROOT" ]; then
  die "$UNIT already runs from $existing_wd, not $ROOT. Re-run with --prefix $(dirname "$existing_wd") to update that installation, or --uninstall it first."
fi
if [ -d "$ROOT/.git" ]; then UPDATE=1; STEPS=9; note "an installation is at $ROOT: this run updates it"; else UPDATE=0; fi
if [ "$UPDATE" = 0 ]; then
  ask ADMIN "First admin's user id" "$ADMIN"
  [[ "$ADMIN" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die "a user id is lowercase letters, digits and dashes, starting with a letter: $ADMIN"
  ask DOOR_HOST "Listen address (127.0.0.1 for this machine only, 0.0.0.0 for the network)" "$DOOR_HOST"
  ask DOOR_PORT "Listen port" "$DOOR_PORT"
  if [ -z "${OPENROUTER_API_KEY:-}" ]; then ask_secret OPENROUTER_API_KEY "OpenRouter API key"; fi
  if [ -z "${THETIS_ADMIN_PASSWORD:-}" ]; then ask_secret THETIS_ADMIN_PASSWORD "Password for $ADMIN"; fi
fi
note "runtime  $ROOT"
note "data     $HOME_DIR"
note "door     http://$DOOR_HOST:$DOOR_PORT"
if [ -n "${OPENROUTER_API_KEY:-}" ]; then note "provider key: given"; elif [ "$UPDATE" = 0 ]; then warn "no OpenRouter key: the model cannot answer until one is in $ROOT/.env"; fi
note "log      $LOG"

# ---------------------------------------------------------------------------------------------------
# The steps.
# ---------------------------------------------------------------------------------------------------
section "Installing"

install_deps() {
  case "$PKG" in
    apt-get) $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends bubblewrap slirp4netns git curl ca-certificates xz-utils rsync ;;
    dnf|yum) $SUDO "$PKG" install -y -q bubblewrap slirp4netns git curl ca-certificates xz rsync ;;
    pacman) $SUDO pacman -Sy --noconfirm --needed bubblewrap slirp4netns git curl ca-certificates xz rsync ;;
    zypper) $SUDO zypper --non-interactive install bubblewrap slirp4netns git curl ca-certificates xz rsync ;;
    apk) $SUDO apk add --no-progress bubblewrap slirp4netns git curl ca-certificates xz rsync ;;
    *) echo "no package manager; assuming bubblewrap, slirp4netns, git, curl and xz are present" ;;
  esac
}
if [ "$DEPS" = 1 ]; then run "OS packages: bubblewrap, slirp4netns, git, xz" install_deps; else skip "OS packages left alone"; fi
for tool in git curl tar xz; do command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed (OS packages were skipped)"; done
if command -v bwrap >/dev/null 2>&1; then
  if bwrap --ro-bind / / --dev /dev --unshare-pid -- true 2>/dev/null; then good "bubblewrap can build a fence here"; else warn "bubblewrap is installed but cannot unshare here; fences run unsandboxed (fence.sandbox auto → none)"; fi
else warn "no bubblewrap: fences run unsandboxed"; fi
if command -v slirp4netns >/dev/null 2>&1; then good "slirp4netns: each fence gets its own network namespace with egress"; else note "no slirp4netns: fences share the host network"; fi

# Node 24. An existing one that is new enough is used as it is; otherwise a release tarball goes under
# ~/.local/lib with symlinks in ~/.local/bin. The fence binds that prefix read-only, whichever it is.
NODE_BASE=https://nodejs.org/dist
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 24 ]; }
node_extract() { # <tarball> <version> <name>: verify the checksum and put the tree in place
  local tarball=$1 version=$2 name=$3 dir="$HOME/.local/lib" sum
  sum=$(curl -fsSL "$NODE_BASE/v$version/SHASUMS256.txt" | awk -v f="$name.tar.xz" '$2==f{print $1}')
  [ -n "$sum" ] || { echo "no checksum for $name in SHASUMS256.txt"; return 1; }
  echo "$sum  $tarball" | sha256sum -c --quiet - || { echo "checksum mismatch for $name.tar.xz"; return 1; }
  echo "sha256 ok: $sum"
  mkdir -p "$dir" "$HOME/.local/bin"
  rm -rf "${dir:?}/${name:?}"; tar -xJf "$tarball" -C "$dir"; rm -f "$tarball"
  ln -sfn "$dir/$name" "$dir/nodejs-current"
  for b in node npm npx corepack; do ln -sfn "$dir/nodejs-current/bin/$b" "$HOME/.local/bin/$b"; done
  echo "linked node, npm, npx, corepack into $HOME/.local/bin"
}
ORIG_PATH=$PATH
export PATH="$HOME/.local/bin:$PATH"
if node_ok; then
  skip "Node $(node -v) is here: $(command -v node)"
else
  want=${NODE_VERSION:-$(curl -fsSL "$NODE_BASE/latest-v24.x/SHASUMS256.txt" | sed -n 's/.*node-v\([0-9.]*\)-linux-x64.tar.xz.*/\1/p' | head -1)}
  [ -n "$want" ] || die "could not read the latest Node 24 version from $NODE_BASE"
  name="node-v$want-linux-$ARCH"; tmp=$(mktemp -d)
  printf '   %s %s[%d/%d]%s Node %s: downloading %s\n' "$DOT" "$DIM" "$((STEP + 1))" "$STEPS" "$RESET" "$want" "$name.tar.xz"
  download "$NODE_BASE/v$want/$name.tar.xz" "$tmp/$name.tar.xz" || die "download of $name.tar.xz failed"
  run "Node $want under ~/.local (sha256 verified)" node_extract "$tmp/$name.tar.xz" "$want" "$name"
  rmdir "$tmp" 2>/dev/null || true
fi
node_ok || die "node is not on PATH after the install; open a new shell and run this again"
NODE=$(command -v node)

# The checkout: runtime with packages as its submodule. A second run pulls instead.
clone() {
  if [ "$UPDATE" = 1 ]; then
    git -C "$ROOT" fetch --tags origin && git -C "$ROOT" checkout -q "$REF" && { git -C "$ROOT" pull --ff-only origin "$REF" || true; } && git -C "$ROOT" submodule update --init --recursive
  else
    if [ ! -d "$PREFIX" ]; then $SUDO mkdir -p "$PREFIX" && $SUDO chown "$(id -un):$(id -gn)" "$PREFIX"; fi
    [ -w "$PREFIX" ] || { echo "$PREFIX is not writable by $(id -un)"; return 1; }
    git clone --recurse-submodules --branch "$REF" "$REPO" "$ROOT"
  fi
  echo "runtime $(git -C "$ROOT" rev-parse --short HEAD) · packages $(git -C "$ROOT/packages" rev-parse --short HEAD)"
}
run "Checkout: thetis-agent/runtime@$REF with packages" clone

build() { cd "$ROOT" && npm ci --no-audit --no-fund --loglevel=error && npm run build; }
run "Build: npm ci and tsc" build

# .env and the configuration file. The key lives in .env; the file references it as ${OPENROUTER_API_KEY}.
configure() {
  cd "$ROOT"
  [ -f .env ] || : >.env
  chmod 600 .env
  local kept key
  kept=$(grep -vE '^(THETIS_HOME|OPENROUTER_API_KEY)=' .env || true)
  key=${OPENROUTER_API_KEY:-$(sed -n 's/^OPENROUTER_API_KEY=//p' .env | head -1)}
  { printf 'OPENROUTER_API_KEY=%s\nTHETIS_HOME=%s\n' "$key" "$HOME_DIR"; [ -n "$kept" ] && printf '%s\n' "$kept"; } >.env
  mkdir -p "$HOME_DIR"
  node bin/thetis.js init
  # The door's address and port are the two fields this installer decides; everything else keeps its default.
  node -e '
    const fs = require("node:fs"); const [file, host, port] = process.argv.slice(1);
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    cfg.door = { ...(cfg.door ?? {}), host, port: Number(port) };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ' "$HOME_DIR/thetis.config.json" "$DOOR_HOST" "$DOOR_PORT"
  echo "config: $HOME_DIR/thetis.config.json (door $DOOR_HOST:$DOOR_PORT)"
}
run "Configuration: .env and $HOME_DIR" configure

# The first admin. On an update the users are already there.
GENERATED=0
first_admin() {
  cd "$ROOT"
  if node bin/thetis.js users list | awk '{print $1}' | grep -qx "$ADMIN"; then echo "user $ADMIN exists"; return 0; fi
  node bin/thetis.js users add "$ADMIN" --admin
  printf '%s\n' "$THETIS_ADMIN_PASSWORD" | node bin/thetis.js users passwd "$ADMIN"
}
if [ "$UPDATE" = 0 ]; then
  if [ -z "${THETIS_ADMIN_PASSWORD:-}" ]; then THETIS_ADMIN_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 20); GENERATED=1; fi
  run "First admin: $ADMIN" first_admin
else skip "users kept"; fi

# The launcher: `thetis` anywhere, talking to the daemon through the socket in $HOME_DIR.
launcher() {
  mkdir -p "$HOME/.local/bin"
  cat >"$LAUNCHER" <<EOF
#!/bin/sh
# Thetis command line for the installation at $ROOT. Generated by deploy/install.sh.
exec "$NODE" "$ROOT/bin/thetis.js" "\$@"
EOF
  chmod 755 "$LAUNCHER"
  # ~/.local/bin on PATH for future shells, once, in whichever rc files exist.
  case ":$ORIG_PATH:" in *":$HOME/.local/bin:"*) ;; *)
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      grep -q 'thetis installer' "$rc" || printf '\n# added by the thetis installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$rc"
    done ;;
  esac
  echo "launcher at $LAUNCHER"
}
run "Launcher: $LAUNCHER" launcher

# Is a daemon answering on the control socket? `thetis status` without one would start a kernel of its own
# and describe that, so the socket is asked directly.
daemon_running() {
  [ -S "$HOME_DIR/thetis.sock" ] || return 1
  node -e 'const s = require("node:net").connect(process.argv[1]); s.once("connect", () => { s.end(); process.exit(0); }).once("error", () => process.exit(1));' "$HOME_DIR/thetis.sock"
}

# One field of `thetis status --json`, by dotted path: `daemon.stale`, `daemon.startedAt`. Empty when the
# daemon does not answer or the field is missing; never a crash, since the callers poll it through a restart.
status_field() { # <path>
  (cd "$ROOT" && node bin/thetis.js status --json 2>/dev/null) | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const v = process.argv[1].split(".").reduce((o, k) => (o == null ? undefined : o[k]), JSON.parse(s)); process.stdout.write(v == null ? "" : String(v)); }
      catch { process.exit(1); }
    });' "$1" 2>/dev/null || true
}

# An update tells the running daemon what changed, and no more than that: the configuration and .env are
# re-read, and every workspace closes and reopens on the code on disk. Neither needs a new process.
reload_daemon() {
  cd "$ROOT"
  node bin/thetis.js config reload
  node bin/thetis.js reload --all
}
if [ "$UPDATE" = 1 ]; then
  if daemon_running; then
    # A running daemon may still hold the previous layout's guest entry path. Let the new daemon
    # load its configuration and open its own fences instead of asking the old one to reopen them.
    if [ "$(status_field daemon.stale)" = true ]; then
      skip "daemon code changed: the new daemon will load the configuration and workspaces"
    else
      run "Reload: configuration, .env and every workspace" reload_daemon
    fi
  else skip "no daemon is running on $HOME_DIR/thetis.sock: nothing to reload"; fi
fi

# The unit, from the template in the checkout with this host's four paths written in. Never the template
# as it is: its paths are placeholders, and a unit that looks installed and is not fails on the next restart.
render_unit() { # <file>
  sed -e "s|^User=.*|User=$(id -un)|" -e "s|^Group=.*|Group=$(id -gn)|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=$ROOT|" \
      -e "s|^ExecStart=.*|ExecStart=$NODE $ROOT/bin/thetis.js serve|" \
      "$ROOT/deploy/thetis-runtime.service" >"$1"
}

# Waits for the door, then prints the status. If the unit stops or stays silent, the last journal lines.
await_door() {
  local i=0
  until curl -fsS -o /dev/null "http://$DOOR_HOST:$DOOR_PORT/login" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -gt 90 ] && { echo "the door did not answer within 90s"; $SUDO journalctl -u "$UNIT" -n 40 --no-pager; return 1; }
    systemctl is-active --quiet "$UNIT" || { echo "$UNIT stopped"; $SUDO journalctl -u "$UNIT" -n 40 --no-pager; return 1; }
    sleep 1
  done
  echo "door answered after ${i}s"
  cd "$ROOT" && node bin/thetis.js status
}

# A fresh install: the unit goes in, is enabled, and is started.
unit_install() {
  local tmp; tmp=$(mktemp); render_unit "$tmp"
  $SUDO install -m 644 "$tmp" "$UNIT_PATH"; rm -f "$tmp"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$UNIT" >/dev/null 2>&1
  if systemctl is-active --quiet "$UNIT"; then $SUDO systemctl restart "$UNIT"; else $SUDO systemctl start "$UNIT"; fi
  await_door
}

# A new daemon process, asked of the daemon itself: `thetis restart` waits for every turn everywhere to end,
# counts down where everyone can see it, and exits so that systemd starts it again. `systemctl restart`, which
# cuts every turn, only when the latch refuses (not supervised, up for under a minute, or a unit whose
# Restart= is not always).
restart_daemon() {
  local before after i=0
  before=$(status_field daemon.startedAt)
  if (cd "$ROOT" && node bin/thetis.js restart --yes --reason "install.sh: daemon code updated"); then
    while [ "$i" -lt 90 ]; do
      i=$((i + 1)); sleep 1
      after=$(status_field daemon.startedAt)
      if [ -n "$after" ] && [ "$after" != "$before" ]; then echo "the daemon restarted itself after ${i}s (started $after)"; return 0; fi
    done
    echo "the restart is still armed after 90s: the daemon is waiting for every turn to end and goes by its own deadline; it is not forced here"
    return 0
  fi
  echo "the daemon refused to restart itself (see above); restarting $UNIT"
  $SUDO systemctl restart "$UNIT"
}

# An update: the unit is rendered again and installed only when it differs from the deployed one, and a new
# daemon process happens only when that unit changed or the daemon reports its own code stale. An update that
# changed only packages restarts nothing; the reload step above already put it into service.
unit_update() {
  local tmp changed=0 stale
  tmp=$(mktemp); render_unit "$tmp"
  if [ -f "$UNIT_PATH" ] && cmp -s "$tmp" "$UNIT_PATH"; then
    echo "unit unchanged: $UNIT_PATH"
  else
    changed=1
    $SUDO install -m 644 "$tmp" "$UNIT_PATH"
    $SUDO systemctl daemon-reload
    echo "unit changed: installed $UNIT_PATH"
  fi
  rm -f "$tmp"
  $SUDO systemctl enable "$UNIT" >/dev/null 2>&1
  if ! systemctl is-active --quiet "$UNIT"; then
    echo "$UNIT was not running: starting it"
    $SUDO systemctl start "$UNIT"
    await_door; return
  fi
  stale=$(status_field daemon.stale)
  case "$stale" in
    true) echo "the daemon is running older code than what is on disk" ;;
    false) echo "the daemon is on the code on disk" ;;
    *) echo "could not read thetis status --json; only a changed unit restarts the daemon" ;;
  esac
  if [ "$changed" = 1 ] || [ "$stale" = true ]; then restart_daemon
  else echo "no restart: nothing the daemon holds has changed"; fi
  await_door
}

if [ "$SERVICE" = 1 ]; then
  [ "$SUDO" = sudo ] && sudo -v </dev/tty
  if [ "$UPDATE" = 1 ]; then run "Service: $UNIT, restarted only if the daemon changed" unit_update
  else run "Service: $UNIT, enabled and started" unit_install; fi
elif [ "$UPDATE" = 1 ] && daemon_running; then
  if [ "$(status_field daemon.stale)" = true ]; then skip "service left alone (--no-service); the daemon runs older code than what is on disk: thetis restart --reason \"daemon code updated\""
  else skip "service left alone (--no-service); the daemon is on the code on disk, nothing to restart"; fi
elif [ -f "$UNIT_PATH" ]; then skip "service left alone (--no-service); start it yourself: sudo systemctl start $UNIT"
else skip "service not installed (--no-service)"; fi

# ---------------------------------------------------------------------------------------------------
# What happened and what to do next.
# ---------------------------------------------------------------------------------------------------
echo
url="http://$DOOR_HOST:$DOOR_PORT/login"
[ "$DOOR_HOST" = "0.0.0.0" ] && url="http://$(hostname -I 2>/dev/null | awk '{print $1}'):$DOOR_PORT/login"
lines=("${BOLD}Thetis is installed${RESET}" "")
if [ "$SERVICE" = 1 ]; then
  lines+=("${GREEN}●${RESET} running as $UNIT" "  open      ${CYAN}$url${RESET}")
else
  lines+=("${YELLOW}●${RESET} not started as a service" "  start     ${CYAN}thetis serve${RESET}" "  then open ${CYAN}$url${RESET}")
fi
[ "$UPDATE" = 0 ] && lines+=("  sign in   ${BOLD}$ADMIN${RESET}")
[ "$GENERATED" = 1 ] && lines+=("  password  ${BOLD}$THETIS_ADMIN_PASSWORD${RESET}  ${DIM}(generated; change it: thetis users passwd $ADMIN)${RESET}")
lines+=("" "  runtime   $ROOT" "  data      $HOME_DIR" "  log       $LOG" "")
lines+=("  ${DIM}thetis status · thetis users add <id> · thetis config · thetis restart${RESET}")
[ "$SERVICE" = 1 ] && lines+=("  ${DIM}journalctl -u $UNIT -f${RESET}")
[ -z "${OPENROUTER_API_KEY:-}" ] && [ "$UPDATE" = 0 ] && lines+=("" "  ${YELLOW}▲${RESET} put OPENROUTER_API_KEY in $ROOT/.env, then: thetis config reload")
case ":$ORIG_PATH:" in *":$HOME/.local/bin:"*) ;; *) lines+=("" "  ${YELLOW}▲${RESET} open a new shell, or: export PATH=\"\$HOME/.local/bin:\$PATH\"") ;; esac
lines+=("" "  ${DIM}update: run this installer again · remove: install.sh --uninstall${RESET}")
box "${lines[@]}"
echo
