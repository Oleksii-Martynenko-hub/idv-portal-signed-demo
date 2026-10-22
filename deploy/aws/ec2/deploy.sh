#!/usr/bin/env bash
# Deploys the files tracked by git to the EC2 instance: rsync to
# /opt/idv-portal, write .env, docker compose up --build, then wait until
# /healthz answers over HTTPS with a trusted certificate.
#
# Required: AWS_REGION, S3_BUCKET. Optional: APP_NAME (default idv-portal),
# TABLE_NAME (default idv-portal), KEY_FILE (default
# ~/.ssh/<APP_NAME>-ec2.pem), INSTANCE_IP (default: the running instance
# tagged Name=<APP_NAME>), PUBLIC_HOST (default INSTANCE_IP; set a DNS name
# that points at the instance to get a certificate for that name instead).
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
APP_NAME="${APP_NAME:-idv-portal}"
TABLE_NAME="${TABLE_NAME:-idv-portal}"
KEY_FILE="${KEY_FILE:-$HOME/.ssh/${APP_NAME}-ec2.pem}"
INSTANCE_IP="${INSTANCE_IP:-}"
APP_DIR=/opt/idv-portal

export AWS_PAGER=""

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../../.." && pwd)"

if [ -z "$INSTANCE_IP" ]; then
  INSTANCE_IP="$(aws ec2 describe-instances \
    --region "$AWS_REGION" \
    --filters "Name=tag:Name,Values=${APP_NAME}" "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].PublicIpAddress | [0]' \
    --output text)"
  if [ -z "$INSTANCE_IP" ] || [ "$INSTANCE_IP" = "None" ]; then
    echo "No running instance tagged Name=$APP_NAME in $AWS_REGION; run launch.sh first, or set INSTANCE_IP." >&2
    exit 1
  fi
fi
PUBLIC_HOST="${PUBLIC_HOST:-$INSTANCE_IP}"

if [ ! -f "$KEY_FILE" ]; then
  echo "Private key $KEY_FILE not found; set KEY_FILE." >&2
  exit 1
fi

ssh_opts=(-i "$KEY_FILE" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)
target="ec2-user@${INSTANCE_IP}"

# --- Files -----------------------------------------------------------------

if ! git -C "$repo_dir" ls-files --error-unmatch Dockerfile docker-compose.yml Caddyfile >/dev/null 2>&1; then
  echo "Dockerfile, docker-compose.yml and Caddyfile must be tracked by git; only tracked files are deployed." >&2
  exit 1
fi

echo "Syncing the files tracked by git to ${target}:${APP_DIR} ..."
# Committed and staged files only. They are copied to a local stage first so
# that --delete also removes files that are no longer tracked.
stage_dir="$(mktemp -d)"
trap 'rm -rf "$stage_dir"' EXIT
git -C "$repo_dir" ls-files -z |
  rsync -a --from0 --files-from=- "$repo_dir/" "$stage_dir/"
# --inplace so that the Caddyfile, bind-mounted into the caddy container,
# keeps its inode and the container sees the new content. The exclude keeps
# --delete away from .env, which is written below.
rsync -az --delete --inplace \
  --exclude /.env \
  -e "ssh ${ssh_opts[*]}" \
  "$stage_dir/" "${target}:${APP_DIR}/"

echo "Writing ${APP_DIR}/.env ..."
ssh "${ssh_opts[@]}" "$target" "umask 077 && cat > ${APP_DIR}/.env" <<EOT
NODE_ENV=production
PORT=8080
AWS_REGION=${AWS_REGION}
S3_BUCKET=${S3_BUCKET}
DYNAMODB_TABLE=${TABLE_NAME}
TRUST_PROXY=1
PUBLIC_HOST=${PUBLIC_HOST}
EOT

# --- Containers ------------------------------------------------------------

echo "Building and starting the containers ..."
ssh "${ssh_opts[@]}" "$target" bash -s <<'EOT'
set -euo pipefail
cd /opt/idv-portal
caddy_before="$(docker compose ps -q caddy)"
docker compose up -d --build --remove-orphans
# Compose recreates caddy when its own configuration changes (PUBLIC_HOST),
# not when the bind-mounted Caddyfile does; reload the kept container.
if [ -n "$caddy_before" ] && [ "$(docker compose ps -q caddy)" = "$caddy_before" ]; then
  docker compose exec -T -w /etc/caddy caddy caddy reload
fi
docker image prune -f >/dev/null
EOT

# --- Health ----------------------------------------------------------------

url="https://${PUBLIC_HOST}/healthz"
echo "Waiting for $url (the first certificate takes a minute) ..."
ready=""
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
  if [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)" = "200" ]; then
    ready=1
    break
  fi
  sleep 5
done
if [ -z "$ready" ]; then
  echo "No healthy answer from $url after 5 minutes. On the instance: cd ${APP_DIR} && docker compose logs caddy app" >&2
  exit 1
fi

# Without -k this only succeeds when the certificate chains to a trusted root.
curl -sSf -o /dev/null --max-time 10 "$url"

echo
echo "Deployed: https://${PUBLIC_HOST}/"
echo "  ssh -i $KEY_FILE $target"
