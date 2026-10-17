#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

[ "$(id -u)" = 0 ] || { echo 'Runtime setup requires root in the new owned distribution.' >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo 'Unsupported runtime architecture.' >&2; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || { echo 'The verified Ubuntu 24.04 rootfs is required.' >&2; exit 1; }
[ ! -e /etc/dockslate ] || { echo 'Runtime setup already exists; automatic replacement is blocked.' >&2; exit 1; }

engine_version='5:29.8.2-1~ubuntu.24.04~noble'
containerd_version='2.3.6-1~ubuntu.24.04~noble'
buildx_version='0.38.0-1~ubuntu.24.04~noble'
compose_version='5.6.0-1~ubuntu.24.04~noble'
mkdir -p /etc/dockslate /etc/apt/keyrings /var/cache/dockslate /usr/local/libexec
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod 755 /usr/sbin/policy-rc.d

apt-get -o Acquire::AllowInsecureRepositories=false -o APT::Get::AllowUnauthenticated=false update
apt-get -o DPkg::Lock::Timeout=300 -o Acquire::AllowInsecureRepositories=false -o APT::Get::AllowUnauthenticated=false install -y --no-install-recommends ca-certificates curl iptables nftables systemd systemd-sysv

download() {
    curl --disable --fail --silent --show-error --noproxy '*' --proto '=https' --tlsv1.2 --connect-timeout 30 --max-time 900 --output "$2" "$1"
    printf '%s  %s\n' "$3" "$2" | sha256sum --check --status
}

download 'https://download.docker.com/linux/ubuntu/gpg' /etc/apt/keyrings/docker.asc '1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570'
chmod 644 /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/dockslate-docker.sources <<'SOURCES'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
apt-get -o Acquire::AllowInsecureRepositories=false -o APT::Get::AllowUnauthenticated=false update

verify_metadata() {
    actual=$(apt-cache show "$1=$2" | sed -n 's/^SHA256: //p')
    [ "$actual" = "$3" ] || { echo 'The signed APT package metadata differs from the pinned payload.' >&2; exit 1; }
}
verify_metadata docker-ce "$engine_version" 'b53a44a6ff13277710978adbdbfea27fcdd7ac9f198017e733d2b8dc2343f8dc'
verify_metadata docker-ce-cli "$engine_version" '008b3b49b474136063fe0fbe8999b0e77c3e8556d7f7de21f98f05715e2f76ba'
verify_metadata containerd.io "$containerd_version" '2eb8c6e244fe6886f2fa2eee9ec418c4b9bb44eb44fca748504f57c23341aed2'
verify_metadata docker-buildx-plugin "$buildx_version" '7094f8b50bc6b239292d475620424a531f7fa0763e466c52ffc3a4037e72bfc5'
verify_metadata docker-compose-plugin "$compose_version" '132266d499d9873aafcbe5b515997b8abd714914fa32a62ccac705c1ede7ca81'
download 'https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-ce_29.8.2-1~ubuntu.24.04~noble_amd64.deb' /var/cache/dockslate/docker-ce.deb 'b53a44a6ff13277710978adbdbfea27fcdd7ac9f198017e733d2b8dc2343f8dc'
download 'https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-ce-cli_29.8.2-1~ubuntu.24.04~noble_amd64.deb' /var/cache/dockslate/docker-ce-cli.deb '008b3b49b474136063fe0fbe8999b0e77c3e8556d7f7de21f98f05715e2f76ba'
download 'https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/containerd.io_2.3.6-1~ubuntu.24.04~noble_amd64.deb' /var/cache/dockslate/containerd.io.deb '2eb8c6e244fe6886f2fa2eee9ec418c4b9bb44eb44fca748504f57c23341aed2'
download 'https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-buildx-plugin_0.38.0-1~ubuntu.24.04~noble_amd64.deb' /var/cache/dockslate/docker-buildx-plugin.deb '7094f8b50bc6b239292d475620424a531f7fa0763e466c52ffc3a4037e72bfc5'
download 'https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-compose-plugin_5.6.0-1~ubuntu.24.04~noble_amd64.deb' /var/cache/dockslate/docker-compose-plugin.deb '132266d499d9873aafcbe5b515997b8abd714914fa32a62ccac705c1ede7ca81'
apt-get -o DPkg::Lock::Timeout=300 -o Acquire::AllowInsecureRepositories=false -o APT::Get::AllowUnauthenticated=false install -y --no-install-recommends /var/cache/dockslate/docker-ce.deb /var/cache/dockslate/docker-ce-cli.deb /var/cache/dockslate/containerd.io.deb /var/cache/dockslate/docker-buildx-plugin.deb /var/cache/dockslate/docker-compose-plugin.deb
[ "$(dpkg-query -W -f='${Version}' docker-ce)" = "$engine_version" ]
[ "$(dpkg-query -W -f='${Version}' docker-ce-cli)" = "$engine_version" ]
[ "$(dpkg-query -W -f='${Version}' containerd.io)" = "$containerd_version" ]
[ "$(dpkg-query -W -f='${Version}' docker-buildx-plugin)" = "$buildx_version" ]
[ "$(dpkg-query -W -f='${Version}' docker-compose-plugin)" = "$compose_version" ]
apt-mark hold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

mkdir -p /etc/docker /etc/systemd/system/docker.service.d /etc/systemd/system/docker.socket.d
printf '{"data-root":"/var/lib/docker","live-restore":false}\n' > /etc/docker/daemon.json
cat > /etc/systemd/system/docker.service.d/dockslate.conf <<'SERVICE'
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd --host=fd:// --containerd=/run/containerd/containerd.sock
SERVICE
cat > /etc/systemd/system/docker.socket.d/dockslate.conf <<'SOCKET'
[Socket]
ListenStream=
ListenStream=/var/run/docker.sock
SocketMode=0600
SocketUser=root
SocketGroup=root
SOCKET
cat > /etc/wsl.conf <<'WSL'
[boot]
systemd=true
[automount]
enabled=true
[interop]
enabled=false
appendWindowsPath=false
WSL

cat > /usr/local/libexec/dockslate-keepalive <<'KEEPALIVE'
#!/bin/sh
set -eu
[ "$(cat /etc/dockslate/schema)" = 1 ]
exec /bin/sleep infinity
KEEPALIVE
cat > /usr/local/libexec/dockslate-start <<'START'
#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
[ "$(cat /etc/dockslate/schema)" = 1 ]
[ "$(cat /proc/1/comm)" = systemd ] || { echo 'systemd did not start in the owned WSL runtime.' >&2; exit 1; }
systemctl start containerd.service docker.socket docker.service
attempt=0
while [ "$attempt" -lt 60 ]; do
    if [ "$(curl --disable --fail --silent --show-error --noproxy '*' --unix-socket /var/run/docker.sock --max-time 2 http://localhost/_ping 2>/dev/null || true)" = OK ]; then exit 0; fi
    attempt=$((attempt + 1))
    sleep 1
done
echo 'The owned Docker Engine did not answer its Unix socket health check.' >&2
exit 1
START
cat > /usr/local/libexec/dockslate-stop <<'STOP'
#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
[ "$(cat /etc/dockslate/schema)" = 1 ]
systemctl stop docker.service docker.socket containerd.service
STOP
chmod 755 /usr/local/libexec/dockslate-keepalive /usr/local/libexec/dockslate-start /usr/local/libexec/dockslate-stop
printf '1\n' > /etc/dockslate/schema
printf '%s\n' "$engine_version" > /etc/dockslate/engine-version
systemctl enable docker.service docker.socket containerd.service
rm /usr/sbin/policy-rc.d
printf 'DockSlate owned runtime setup completed.\n'
