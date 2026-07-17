#!/bin/bash
set -e

SERVER_DIR="$HOME/Documents/Coding/OwnLift/OwnLift-Server"
DOCKER_IMAGE="superak0s/ownlift-server"

echo "=== OwnLift Server Release Script ==="

if ! docker info > /dev/null 2>&1; then
    echo "ERROR: Docker is not running."
    exit 1
fi

# ─── [0/3] Version Bump ───────────────────────────────────────────────────────
echo ""
echo "[0/3] Version management..."

CURRENT_VERSION=$(node -e "console.log(require('$SERVER_DIR/package.json').version)")
AUTO_VERSION=$(node -e "const v='$CURRENT_VERSION'.split('.'); v[2]=parseInt(v[2])+1; console.log(v.join('.'))")

echo "Current version: $CURRENT_VERSION"
echo ""
echo "[1] Auto-increment to $AUTO_VERSION"
echo "[2] Enter custom version"
echo ""
read -rp "Choose (1 or 2, default=1): " VERSION_CHOICE
VERSION_CHOICE="${VERSION_CHOICE:-1}"

if [ "$VERSION_CHOICE" = "2" ]; then
    read -rp "Enter custom version (e.g. 2.0.0): " NEW_VERSION
    if [ -z "$NEW_VERSION" ]; then
        echo "ERROR: No version entered."
        exit 1
    fi
else
    NEW_VERSION="$AUTO_VERSION"
fi

echo "Updating version to: $NEW_VERSION"

node -e "
const fs = require('fs');
const p = require('$SERVER_DIR/package.json');
p.version = '$NEW_VERSION';
fs.writeFileSync('$SERVER_DIR/package.json', JSON.stringify(p, null, 2) + '\n');
"

echo "Version updated successfully!"

# ─── [1/3] Push source to GitHub ─────────────────────────────────────────────
echo ""
echo "[1/3] Pushing source code to GitHub..."
cd "$SERVER_DIR"
git add .
read -rp "Enter commit message (or press Enter for default): " COMMIT_MSG
COMMIT_MSG="${COMMIT_MSG:-Release update}"
git diff --quiet && git diff --staged --quiet || git commit -m "$COMMIT_MSG"
git push origin main

# ─── [2/3] Build Docker image ────────────────────────────────────────────────
echo ""
echo "[2/3] Building Docker image..."
cd "$SERVER_DIR"

VERSION=$(node -p "require('./package.json').version")
echo "Building v$VERSION..."

docker build -t "$DOCKER_IMAGE:latest" -t "$DOCKER_IMAGE:$VERSION" .

# ─── [3/3] Push to Docker Hub ────────────────────────────────────────────────
echo ""
echo "[3/3] Pushing image to Docker Hub..."
docker push "$DOCKER_IMAGE:latest"
docker push "$DOCKER_IMAGE:$VERSION"

echo ""
echo "=== Done! Pushed as :latest and :$VERSION ==="