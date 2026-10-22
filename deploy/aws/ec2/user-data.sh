#!/usr/bin/env bash
# First-boot setup for the Amazon Linux 2023 host: Docker from the
# distribution, the compose plugin from its GitHub release (AL2023 does not
# package it), a swap file, and the application directory. cloud-init runs
# this as root; it can be run again by hand.
set -euo pipefail

COMPOSE_VERSION=v5.6.1
APP_DIR=/opt/idv-portal
PLUGIN_DIR=/usr/local/lib/docker/cli-plugins

dnf install -y docker rsync
systemctl enable --now docker
usermod -aG docker ec2-user

# Images are built on the instance; a swap file keeps npm and tsc from being
# killed on 1 GiB of memory.
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
swapon --show=NAME --noheadings | grep -qx /swapfile || swapon /swapfile

# uname -m gives aarch64 or x86_64, which is how the release assets are named.
arch="$(uname -m)"
asset="docker-compose-linux-${arch}"
if ! "$PLUGIN_DIR/docker-compose" version 2>/dev/null | grep -q "$COMPOSE_VERSION"; then
  tmp="$(mktemp -d)"
  base="https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}"
  curl -fsSL -o "$tmp/$asset" "${base}/${asset}"
  curl -fsSL -o "$tmp/$asset.sha256" "${base}/${asset}.sha256"
  (cd "$tmp" && sha256sum -c "$asset.sha256")
  install -D -m 0755 "$tmp/$asset" "$PLUGIN_DIR/docker-compose"
  rm -rf "$tmp"
fi

install -d -o ec2-user -g ec2-user "$APP_DIR"
