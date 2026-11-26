#!/usr/bin/env bash
# Ships the committed HEAD to the VPS and restarts the keeper. It installs the reference agent's
# unit (horagon-agent) but never enables, starts or restarts it: a running agent keeps the
# previous revision until it is restarted by hand (a restart also clears its anomaly stops), and
# the script prints which. Needs no git remote: the tree goes over ssh as a tarball. Run it in
# Git Bash from anywhere in the repo (it moves to the root first): bash ops/deploy-keeper.sh
# Keys and .env.keeper stay on the VPS; this script never copies or prints them.
#
# The live-game guard: before anything ships, it runs `horagon-ops deploy-check` on the VPS
# (the deployed revision, with the keeper's own .env.keeper) and refuses while a game is between
# tip-off - 60 min and its market's close (open, or halted on a live or final game with no
# result proposed yet), printing those games. A restart there holds back buzzer halts until the
# new process reads ESPN, and pages feed-silent: for every open market past S + 1h40m.
# --force deploys anyway. When the check cannot run (a deployed revision without it, or a
# database that does not answer), it prints a warning with the check to run by hand and waits
# 10 s before it goes on.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *)
      echo "usage: bash ops/deploy-keeper.sh [--force]" >&2
      exit 1
      ;;
  esac
done

HOST="${HORAGON_VPS:-horagon-vps}"
REV="$(git rev-parse --short HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first: the deploy ships HEAD ($REV), not the working tree." >&2
  exit 1
fi

echo "Checking $HOST for a game in its live window"
check=0
# Node reads .env.keeper itself (--env-file): no shell evaluates its lines.
check_out="$(ssh "$HOST" 'bash -l -s' 2>&1 <<'CHECK'
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd ~/horagon/apps/keeper
exec ./node_modules/.bin/tsx --env-file="$HOME/horagon/.env.keeper" src/ops/cli.ts deploy-check
CHECK
)" || check=$?

case "$check" in
  0)
    printf '%s\n' "$check_out"
    ;;
  2)
    printf '%s\n' "$check_out" >&2
    if [ "$FORCE" = 1 ]; then
      echo "--force: deploying while those games are live; the restart holds back their halts." >&2
    else
      echo "Refusing to restart the keeper: deploy after those markets close, or pass --force." >&2
      exit 1
    fi
    ;;
  *)
    # The CLI's own `error:` line, not what the login shell printed before it: the lines that
    # name an error, else the last 3.
    shown="$(printf '%s\n' "$check_out" | grep -i 'error' | tail -n 3 || true)"
    [ -n "$shown" ] || shown="$(printf '%s\n' "$check_out" | tail -n 3)"
    {
      echo "!!! WARNING: the live-game check did not run on $HOST (exit $check):"
      printf '%s\n' "$shown" | sed 's/^/!!!   /'
      echo "!!! The deployed revision may predate horagon-ops deploy-check, or its database did not answer."
      echo "!!! Check by hand before the keeper restarts:"
      echo "!!!   horagon-ops status"
      echo "!!! A game with tip-off within 60 min, market:open, or market:halted on a live or final"
      echo "!!! game, blocks the restart: stop now (Ctrl-C) and deploy after its market closes."
    } >&2
    if [ "$FORCE" = 1 ]; then
      echo "--force: deploying without the check." >&2
    else
      echo "!!! Deploying in 10 s." >&2
      sleep 10
    fi
    ;;
esac

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
  ops/systemd/horagon-watchdog.timer ops/systemd/horagon-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now horagon-watchdog.timer
# Enabled so the keeper comes back after a VPS reboot (lingering starts the user manager).
systemctl --user enable horagon-keeper
systemctl --user restart horagon-keeper
sleep 5
systemctl --user --no-pager status horagon-keeper | head -n 12
# The reference agent: installed, never enabled, started or restarted here. A restart would
# silently clear the markets its anomaly check stopped, so it stays a manual step.
if systemctl --user --quiet is-active horagon-agent; then
  echo "horagon-agent: active, still running the previous revision; systemctl --user restart horagon-agent picks up $1 and clears its anomaly stops"
else
  echo "horagon-agent: $(systemctl --user is-active horagon-agent || true) (started by hand only)"
fi
REMOTE
