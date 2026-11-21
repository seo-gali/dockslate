#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
[ "$(id -u)" = 0 ] || { echo 'Runtime readiness verification requires root.' >&2; exit 1; }
[ "$(cat /etc/dockslate/schema)" = 1 ] || { echo 'The owned runtime schema could not be verified.' >&2; exit 1; }

# WSL can accept exec before the systemd manager socket answers requests.
deadline=$(($(date +%s) + 30))
while :; do
    remaining=$((deadline - $(date +%s)))
    if [ "$remaining" -le 0 ]; then
        echo 'The DockSlate systemd manager did not become reachable within 30 seconds. Docker services were not changed. If this persists, stop only the DockSlate distribution after saving container work, then retry startup. Existing data was preserved.' >&2
        exit 1
    fi
    if [ "$remaining" -gt 2 ]; then remaining=2; fi
    if [ "$(cat /proc/1/comm)" = systemd ] && timeout "$remaining" systemctl --system show --property=Version --value >/dev/null 2>&1; then break; fi
    sleep 1
done
