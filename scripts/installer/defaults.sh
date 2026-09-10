#!/bin/sh
# Generated from scripts/installer/*.sh by scripts/installer.ts; edit those sources (ADR 0052).
# Stand up a supervised Zero kernel service from a signed release, verifying every byte before
# anything is written and printing every privileged step; ADR 0048, ADR 0049, ADR 0050.
# POSIX sh (dash): no pipefail, so every pipe writes to a file and its status is checked.
set -eu

ZERO_REPO='https://github.com/thetis-agent/runtime'
ZERO_TAG='v0.1.0'
ZERO_RELEASE_URL='https://github.com/thetis-agent/runtime/releases/download'
ZERO_SIGNER='release@thetis-agent'
ZERO_NAMESPACE='zero-release'
# The one-liner's trust root is this script and its pins. Rotation ships a new line here,
# in a release signed with the key being retired (docs/ci-delivery.md).
ZERO_ALLOWED_SIGNERS='release@thetis-agent namespaces="zero-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholderUntilTheFirstReleaseIsCut'
STATE_ROOT_LIMIT=18
PASSWORD_MINIMUM=12
SYSTEMD_MINIMUM=252
DEFAULT_STATE_SIZE=4294967296
ASSETS='thetis-distribution.tar.gz package.json profile.lock.json registry.json registry.bundle provenance.json platform.txt kernel-pins.json install.sh SHA256SUMS SHA256SUMS.sig'
SIGNED_ASSETS=9

prefix='/opt/zero'
state='/var/lib/z'
state_size=''
state_layout='one'
no_mount=0
service='system'
service_user='zero'
operator=''
password_fd=''
origin=''
auto_update='none'
key_store='file'
release=''
release_url=''
node_url='https://nodejs.org/dist'
remote=''
allowed_signers=''
assume_yes=0
dry_run=0
do_uninstall=0
purge_state=0
allow_root=0
print_unit=''
prefix_set=0
state_set=0
service_set=0
unit_directory=''
credential_path=''
linger_created=0
user_created=0
tmp=''
terminal_hidden=0
umask 077

die() { printf '%s\n' "$1" >&2; exit 1; }
say() { printf '%s\n' "$1"; }

usage() {
  cat <<'EOF'
Usage: install.sh [flags]

  --prefix <dir>             Code prefix (default /opt/zero)
  --state <dir>              State volume root (default /var/lib/z)
  --state-size <bytes>       Size of the provisioned state volume (default 4294967296)
  --state-layout one|split   One volume, or a second small volume for the seed root
  --no-mount                 Use an existing bounded mountpoint instead of provisioning one
  --service system|user|none Run as a system service, a user service, or in the foreground
  --user <name>              Service account for --service system (default zero)
  --operator <id>            Administrator account id (default admin, or prompted)
  --password-fd <n>          Read the administrator password from this open descriptor
  --origin <url>             Public origin for the sign-in line and the proxy rules
  --auto-update none         Update policy; only none is accepted (ADR 0049)
  --key-store file|tpm2      Where the kernel master key is held
  --release <tag>            Release tag to install (default the tag this script pins)
  --release-url <url>        Base assets are read from at <url>/<tag>/<asset>
  --node-url <url>           Node archive mirror (default https://nodejs.org/dist)
  --remote <url>             Git remote release tags are read from (https:// or file://)
  --allowed-signers <path>   allowed_signers file trusted for the release signature
  --yes                      Do not prompt; a password source is then required
  --dry-run                  Print every privileged step and write nothing
  --uninstall                Remove the installed prefix
  --purge-state              With --uninstall, also remove the state volume's contents
  --allow-root               Permit running as root under sudo from a login shell
  --print-unit <name>        Print one embedded unit template and exit
  --help                     Show this text
EOF
}
