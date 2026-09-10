#!/bin/sh
# Generated from scripts/installer/*.sh by scripts/installer.ts; edit those sources (implementation note 0052).
# Stand up a supervised Thetis kernel service from a signed release, verifying every byte before
# anything is written and printing every privileged step; ADR 0048, ADR 0049, implementation note 0050.
# POSIX sh (dash): no pipefail, so every pipe writes to a file and its status is checked.
set -eu

THETIS_REPO='https://github.com/thetis-agent/runtime'
THETIS_TAG='v0.1.1'
THETIS_RELEASE_URL='https://github.com/thetis-agent/runtime/releases/download'
THETIS_SIGNER='release@thetis-agent'
# Retain the existing cryptographic namespace so published signatures remain verifiable.
THETIS_NAMESPACE='zero-release'
# The one-liner's trust root is this script and its pins. Rotation ships a new line here,
# in a release signed with the key being retired (docs/ci-delivery.md).
THETIS_ALLOWED_SIGNERS='release@thetis-agent namespaces="zero-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF11pGLCkpbhH79zkcdjDOD1xhUt/ZYZVX2t7dXN9CwT'
STATE_ROOT_LIMIT=18
PASSWORD_MINIMUM=6
SYSTEMD_MINIMUM=252
DEFAULT_STATE_SIZE=4294967296
ASSETS='thetis-distribution.tar.gz package.json profile.lock.json registry.json registry.bundle provenance.json platform.txt kernel-pins.json install.sh SHA256SUMS SHA256SUMS.sig'
SIGNED_ASSETS=9

prefix='/opt/thetis'
state='/var/lib/thetis'
state_size=''
state_layout='one'
no_mount=0
service='system'
service_name='thetis'
service_user='thetis'
operator=''
password_fd=''
api_key_fd=''
api_key_value=''
model=''
daily_budget='10'
provider_config=''
demo=0
origin=''
kernel_origin=''
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

  --prefix <dir>             Code prefix (default /opt/thetis)
  --state <dir>              State volume root (default /var/lib/thetis)
  --state-size <bytes>       Size of the provisioned state volume (default 4294967296)
  --state-layout one|split   One volume, or a second small volume for the seed root
  --no-mount                 Use an existing bounded mountpoint instead of provisioning one
  --service system|user|none Run as a system service, a user service, or in the foreground
  --service-name <name>      Unit and credential namespace (default thetis)
  --user <name>              Service account for --service system (default thetis)
  --operator <id>            Administrator account id (default admin, or prompted)
  --password-fd <n>          Read the administrator password from this open descriptor
  --model <id>               OpenRouter model id (prompted for interactive installs)
  --api-key-fd <n>           Read the provider API key from this open descriptor
  --daily-budget <amount>    Per-person daily model budget in USD (default 10)
  --provider-config <path>   JSON endpoint, model capabilities/prices and dailyBudget
  --demo                    Use a clearly labelled offline demo instead of a real model
  --origin <url>             Public origin for the sign-in line and the proxy rules
  --kernel-origin <url>      Separate trusted origin (default https://kernel.<public-host>)
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
  --allow-root               Compatibility flag; sudo is supported without this flag
  --print-unit <name>        Print one embedded unit template and exit
  --help                     Show this text
EOF
}
