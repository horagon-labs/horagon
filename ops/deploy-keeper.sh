#!/usr/bin/env bash
# Ships the committed HEAD to the VPS and restarts the keeper. Needs no git remote: the tree
# goes over ssh as a tarball. Run from the repo root in Git Bash: bash ops/deploy-keeper.sh
# Keys and .env.keeper stay on the VPS; this script never copies them.
set -euo pipefail

HOST="${HORAGON_VPS:-horagon-vps}"
REV="$(git rev-parse --short HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first: the deploy ships HEAD ($REV), not the working tree." >&2
  exit 1
fi

echo "Deploying $REV to $HOST"
git archive --format=tar HEAD | ssh "$HOST" 'mkdir -p ~/horagon && tar -x -C ~/horagon'
# A login shell: on this VPS the Node 22 toolchain is only on the login shell's PATH.
ssh "$HOST" 'bash -l -s' "$REV" <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd ~/horagon
echo "$1" > REVISION
corepack pnpm install --frozen-lockfile --filter @horagon/keeper...
corepack pnpm --filter @horagon/sdk build
mkdir -p ~/.config/systemd/user
cp ops/systemd/horagon-keeper.service ops/systemd/horagon-watchdog.service \
  ops/systemd/horagon-watchdog.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now horagon-watchdog.timer
# Enabled so the keeper comes back after a VPS reboot (lingering starts the user manager).
systemctl --user enable horagon-keeper
systemctl --user restart horagon-keeper
sleep 5
systemctl --user --no-pager status horagon-keeper | head -n 12
REMOTE
