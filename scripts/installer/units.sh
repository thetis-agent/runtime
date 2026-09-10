# --- embedded units: the authoritative text, copied for review under units/ (ADR 0048) --------
unit_zero_service() {
  cat <<'EOF'
# ADR 0048: the service runs the supervisor, never kernel/main.ts, so every later kernel start
# is a GN-007 transaction rather than a restart outside the generation machine.
[Unit]
Description=Zero kernel supervisor
RequiresMountsFor=@STATE@
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=@USER@
Group=@USER@
Delegate=yes
LoadCredential=master:/etc/zero/master.key
ExecStart=/bin/sh -c 'exec @PREFIX@/node/current/bin/node --max-old-space-size=32 --max-semi-space-size=1 --no-experimental-strip-types --import @PREFIX@/current/lib/artifacts/register.mjs @PREFIX@/current/kernel/supervisor-main.ts @PREFIX@/etc/seed.json --release @PREFIX@/current --state @STATE@ --installation @PREFIX@ --credential "$CREDENTIALS_DIRECTORY/master" --delegate'
KillMode=mixed
TimeoutStopSec=90
MemoryMax=2G
TasksMax=512
DeviceAllow=/dev/net/tun rw
ProtectSystem=strict
ReadWritePaths=@STATE@
ProtectHome=yes
NoNewPrivileges=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
EOF
}

unit_zero_update_service() {
  cat <<'EOF'
# ADR 0048: the timer only checks, stages and verifies; an administrator applies. ADR 0049 holds
# every update policy but none refused, so this unit never changes the kernel.
[Unit]
Description=Zero update check
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=@USER@
Group=@USER@
ExecStart=@PREFIX@/bin/zero update --check
ProtectSystem=strict
ReadWritePaths=@PREFIX@/releases @STATE@/updates
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
PrivateDevices=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=256M
TimeoutStartSec=15min
EOF
}

unit_zero_update_timer() {
  cat <<'EOF'
[Unit]
Description=Zero update check

[Timer]
OnCalendar=hourly
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

unit_state_mount() {
  cat <<'EOF'
# ADR 0048 D7: the state volume's enforced capacity is the deployment's declared quota, which is
# what lib/sandbox-runner/index.ts compares against statfs.
[Unit]
Description=Zero state volume

[Mount]
What=@STATE@.img
Where=@STATE@
Type=ext4
Options=loop,nosuid,nodev,noexec

[Install]
WantedBy=multi-user.target
EOF
}

unit_text() {
  case "$1" in
    zero.service) unit_zero_service ;;
    zero-update.service) unit_zero_update_service ;;
    zero-update.timer) unit_zero_update_timer ;;
    state.mount) unit_state_mount ;;
    *) die "There is no embedded unit named $1." ;;
  esac
}

