#!/bin/bash
set -e

SERVER_DIR="$HOME/OwnLift/OwnLift-Server"
DOCKER_IMAGE="superak0s/ownlift-server"
SEMVER_REGEX='^[0-9]+\.[0-9]+\.[0-9]+$'

echo "=== OwnLift Server Release Script ==="

if ! docker info > /dev/null 2>&1; then
    echo "ERROR: Docker is not running."
    exit 1
fi

cd "$SERVER_DIR"

# ─── [0/4] Sync check ─────────────────────────────────────────────────────────
echo ""
echo "[0/4] Checking branch is up to date with origin/main..."
git fetch origin main
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse origin/main)
BASE=$(git merge-base HEAD origin/main)

if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ] && [ "$BASE" = "$LOCAL_HEAD" ]; then
    echo "ERROR: Local main is behind origin/main. Run 'git pull --rebase origin main' first."
    exit 1
elif [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ] && [ "$BASE" != "$REMOTE_HEAD" ]; then
    echo "ERROR: Local main has diverged from origin/main. Resolve manually before releasing."
    exit 1
fi

# ─── [1/4] Version Bump ───────────────────────────────────────────────────────
echo ""
echo "[1/4] Version management..."

CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
AUTO_VERSION=$(node -e "const v='$CURRENT_VERSION'.split('.'); v[2]=parseInt(v[2])+1; console.log(v.join('.'))")

echo "Current version: $CURRENT_VERSION"
echo ""
echo "[1] Auto-increment to $AUTO_VERSION"
echo "[2] Enter custom version"
echo ""
read -rp "Choose (1 or 2, default=1): " VERSION_CHOICE
VERSION_CHOICE="${VERSION_CHOICE:-1}"

if [ "$VERSION_CHOICE" = "2" ]; then
    while true; do
        read -rp "Enter custom version (e.g. 2.0.0): " NEW_VERSION
        if [ -z "$NEW_VERSION" ]; then
            echo "ERROR: No version entered."
            exit 1
        fi
        if [[ "$NEW_VERSION" =~ $SEMVER_REGEX ]]; then
            break
        fi
        echo "Invalid format. Expected MAJOR.MINOR.PATCH (e.g. 2.0.0). Try again."
    done
else
    NEW_VERSION="$AUTO_VERSION"
fi

echo "Updating version to: $NEW_VERSION"

node -e "
const fs = require('fs');
const p = require('./package.json');
p.version = '$NEW_VERSION';
fs.writeFileSync('./package.json', JSON.stringify(p, null, 2) + '\n');
"

echo "Version updated successfully!"

# Commit the version bump on its own so it's never mixed with unrelated changes
if ! git diff --quiet -- package.json; then
    git add package.json
    git commit -m "chore: bump version to $NEW_VERSION"
else
    echo "package.json already up to date (no version diff to commit)."
fi

# ─── [2/4] Push source to GitHub ─────────────────────────────────────────────
echo ""
echo "[2/4] Pushing source code to GitHub..."

git add .
read -rp "Enter commit message (or press Enter for default): " COMMIT_MSG
COMMIT_MSG="${COMMIT_MSG:-Release update}"
git diff --quiet && git diff --staged --quiet || git commit -m "$COMMIT_MSG"
git push origin main

TAG="v$NEW_VERSION"
if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "WARNING: Tag $TAG already exists locally, skipping tag creation."
else
    git tag -a "$TAG" -m "Release $TAG"
    git push origin "$TAG"
    echo "Tagged and pushed $TAG"
fi

# ─── [3/4] Build Docker image ────────────────────────────────────────────────
echo ""
echo "[3/4] Building Docker image..."

VERSION=$(node -p "require('./package.json').version")
echo "Building v$VERSION..."

docker build -t "$DOCKER_IMAGE:latest" -t "$DOCKER_IMAGE:$VERSION" .

# ─── [4/4] Push to Docker Hub ────────────────────────────────────────────────
echo ""
read -rp "[4/4] Push image to Docker Hub as :latest and :$VERSION? [Y/n] " PUSH_CONFIRM
PUSH_CONFIRM="${PUSH_CONFIRM:-Y}"

if [[ "$PUSH_CONFIRM" =~ ^[Yy]$ ]]; then
    docker push "$DOCKER_IMAGE:latest"
    docker push "$DOCKER_IMAGE:$VERSION"
    echo ""
    echo "=== Done! Pushed as :latest and :$VERSION ==="
else
    echo ""
    echo "=== Skipped Docker Hub push. Image built locally as :latest and :$VERSION ==="
fi