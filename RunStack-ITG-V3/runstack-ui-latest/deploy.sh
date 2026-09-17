#!/usr/bin/env bash
# deploy.sh — Build RunStack UI and deploy to EC2 via rsync/scp
# Usage: ./deploy.sh [EC2_HOST] [SSH_KEY_PATH]
# Example: ./deploy.sh ec2-12-34-56-78.compute-1.amazonaws.com ~/.ssh/my-key.pem

set -euo pipefail

EC2_HOST="${1:-}"
SSH_KEY="${2:-~/.ssh/id_rsa}"
REMOTE_DIR="/var/www/runstack-ui"
REMOTE_USER="ec2-user"   # Change to 'ubuntu' if using Ubuntu AMI

if [[ -z "$EC2_HOST" ]]; then
  echo "Usage: $0 <EC2_HOST> [SSH_KEY_PATH]"
  echo "Example: $0 ec2-12-34-56-78.compute-1.amazonaws.com ~/.ssh/my-key.pem"
  exit 1
fi

# ── 1. Validate .env ──────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  echo "ERROR: .env file not found. Copy .env.example to .env and fill in your values."
  exit 1
fi

echo "✓ .env found"

# ── 2. Install dependencies ───────────────────────────────────────────────────
echo "→ Installing dependencies..."
npm ci --silent

# ── 3. Build ──────────────────────────────────────────────────────────────────
echo "→ Building React app..."
npm run build

echo "✓ Build complete ($(du -sh build | cut -f1))"

# ── 4. Ensure remote directory exists ─────────────────────────────────────────
echo "→ Preparing EC2..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${REMOTE_USER}@${EC2_HOST}" \
  "sudo mkdir -p ${REMOTE_DIR} && sudo chown ${REMOTE_USER}:${REMOTE_USER} ${REMOTE_DIR}"

# ── 5. Sync build to EC2 ──────────────────────────────────────────────────────
echo "→ Deploying to ${EC2_HOST}:${REMOTE_DIR}..."
rsync -az --delete \
  -e "ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no" \
  build/ "${REMOTE_USER}@${EC2_HOST}:${REMOTE_DIR}/"

# ── 6. Install nginx config (first deploy only) ───────────────────────────────
echo "→ Syncing nginx config..."
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
  nginx/runstack-ui.conf "${REMOTE_USER}@${EC2_HOST}:/tmp/runstack-ui.conf"

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${REMOTE_USER}@${EC2_HOST}" "
  sudo cp /tmp/runstack-ui.conf /etc/nginx/sites-available/runstack-ui
  sudo ln -sf /etc/nginx/sites-available/runstack-ui /etc/nginx/sites-enabled/runstack-ui
  sudo nginx -t && sudo systemctl reload nginx
  echo '✓ Nginx reloaded'
"

echo ""
echo "✅ Deploy complete!"
echo "   Open: http://${EC2_HOST}/"
echo ""
echo "   Next: Make sure EC2 Security Group allows port 80 from your IP."
echo "   Tip:  Run 'sudo journalctl -u nginx -f' on EC2 to tail nginx logs."
