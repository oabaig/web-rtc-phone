#!/usr/bin/env bash
# Build the image locally, ship it to the Unraid box over SSH, and
# (re)start the container. Deploying an update = re-running this script.
#
# One-time setup on Unraid: enable SSH (Settings -> Management Access).
# Optional: ssh-copy-id root@<unraid> so deploys don't prompt for a password.
#
# HTTPS: if /mnt/user/appdata/webrtc-phone/certs/{cert,key}.pem exist on the
# Unraid box, the container serves HTTPS with them; otherwise plain HTTP.
# (Remove the certs and redeploy once Pangolin terminates TLS instead.)
#
# Usage: bash deploy/unraid.sh <unraid-ip-or-host>
set -euo pipefail

UNRAID_HOST="${1:-${UNRAID_HOST:-}}"
[ -n "$UNRAID_HOST" ] || { echo "usage: bash deploy/unraid.sh <unraid-ip-or-host>"; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE=webrtc-phone
APPDATA=/mnt/user/appdata/webrtc-phone

echo "==> building image"
docker build -t "$IMAGE" "$REPO_ROOT"

echo "==> shipping image to $UNRAID_HOST"
TARBALL="$(mktemp -t webrtc-phone-XXXXXX.tar)"
trap 'rm -f "$TARBALL"' EXIT
docker save -o "$TARBALL" "$IMAGE"
scp "$TARBALL" "root@$UNRAID_HOST:/tmp/webrtc-phone.tar"

echo "==> loading image and (re)starting container"
ssh "root@$UNRAID_HOST" bash -s <<EOF
set -euo pipefail
docker load -i /tmp/webrtc-phone.tar
rm -f /tmp/webrtc-phone.tar
docker rm -f $IMAGE >/dev/null 2>&1 || true
if [ -f "$APPDATA/certs/cert.pem" ] && [ -f "$APPDATA/certs/key.pem" ]; then
  docker run -d --name $IMAGE --restart unless-stopped \
    -p 3001:3001 \
    -v "$APPDATA/certs:/certs:ro" \
    -e TLS_CERT=/certs/cert.pem -e TLS_KEY=/certs/key.pem \
    $IMAGE
  echo "started with HTTPS (certs from $APPDATA/certs)"
else
  docker run -d --name $IMAGE --restart unless-stopped -p 3001:3001 $IMAGE
  echo "started plain HTTP (no certs at $APPDATA/certs)"
fi
docker image prune -f >/dev/null
docker ps --filter name=$IMAGE --format '{{.Names}}  {{.Status}}  {{.Ports}}'
EOF

echo "==> done"
