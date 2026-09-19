#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
DOCKER_IMAGE="superak0s/ownlift-server"

usage() {
    cat <<'EOF'
Usage: scripts/release.sh [--no-push] [--no-test] [--no-docker-push] [-h]

  --no-push         Skip the git commit/push/tag step. The image is still built
                    and pushed; the version bump stays local and uncommitted.
  --no-test         Skip vitest in the pre-build verification. Typecheck still runs.
  --no-docker-push  Build the image but don't push it to Docker Hub (implies no
                    confirmation prompt).
  -h, --help        Show this help.
EOF
}

SKIP_PUSH=false
SKIP_TESTS=false
SKIP_DOCKER_PUSH=false
for arg in "$@"; do
    case "$arg" in
        --no-push) SKIP_PUSH=true ;;
        --no-test) SKIP_TESTS=true ;;
        --no-docker-push) SKIP_DOCKER_PUSH=true ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
    esac
done

echo "=== OwnLift Server Release Script ==="

if ! docker info > /dev/null 2>&1; then
    echo "ERROR: Docker is not running."
    exit 1
fi

cd "$SERVER_DIR"

# ─── [0/5] Sync check ─────────────────────────────────────────────────────────
echo ""
if [ "$SKIP_PUSH" = true ]; then
    echo "[0/5] --no-push set - skipping origin/main sync check."
else
    echo "[0/5] Checking branch is up to date with origin/main..."
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
fi

# ─── [1/5] Version Bump ───────────────────────────────────────────────────────
echo ""
echo "[1/5] Version management..."

CURRENT_VERSION=$(node -p "require('./package.json').version")
IFS='.' read -r CUR_MAJOR CUR_MINOR CUR_PATCH <<< "$CURRENT_VERSION"
AUTO_PATCH_VERSION="$CUR_MAJOR.$CUR_MINOR.$((CUR_PATCH + 1))"
AUTO_MINOR_VERSION="$CUR_MAJOR.$((CUR_MINOR + 1)).0"

echo "Current version: $CURRENT_VERSION"
echo ""
echo "[1] Increment patch to $AUTO_PATCH_VERSION"
echo "[2] Increment minor to $AUTO_MINOR_VERSION (resets patch to 0)"
echo "[3] Enter custom version"
echo "[4] Keep current version ($CURRENT_VERSION)"
echo ""
read -rp "Choose (1-4, default=1): " VERSION_CHOICE
KEEP_VERSION=false

case "${VERSION_CHOICE:-1}" in
    2) NEW_VERSION="$AUTO_MINOR_VERSION" ;;
    3) read -rp "Enter custom version (e.g. 2.0.0): " NEW_VERSION ;;
    4) NEW_VERSION="$CURRENT_VERSION"; KEEP_VERSION=true ;;
    *) NEW_VERSION="$AUTO_PATCH_VERSION" ;;
esac

# Docker tags and git tags both assume a plain x.y.z.
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: '$NEW_VERSION' is not a valid x.y.z version."
    exit 1
fi

echo "Updating version to: $NEW_VERSION"

# Asked up front so the rest of the run is unattended.
# Keeping the version amends the existing commit, so no message is needed.
if [ "$KEEP_VERSION" = false ] && [ "$SKIP_PUSH" = false ]; then
    read -rp "Commit message (Enter for 'Release v$NEW_VERSION'): " COMMIT_MSG
    COMMIT_MSG="${COMMIT_MSG:-Release v$NEW_VERSION}"
fi

NEW_VERSION="$NEW_VERSION" node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
pkg.version = process.env.NEW_VERSION;
fs.writeFileSync("./package.json", JSON.stringify(pkg, null, 2) + "\n");
'
echo "Version updated to $NEW_VERSION"

trap 'echo ""; echo "Build failed - reverting version bump."; git checkout -- package.json' ERR

# ─── [2/5] Verify ────────────────────────────────────────────────────────────
echo ""
echo "[2/5] Verifying before build (typecheck + tests)..."

npx tsc --noEmit
if [ "$SKIP_TESTS" = true ]; then
    echo "--no-test set - skipping vitest."
else
    npm test
fi

echo "Verification passed."

# ─── [3/5] Build Docker image ────────────────────────────────────────────────
echo ""
echo "[3/5] Building Docker image v$NEW_VERSION..."

docker build -t "$DOCKER_IMAGE:latest" -t "$DOCKER_IMAGE:$NEW_VERSION" .

trap - ERR

# ─── [4/5] Push source to GitHub ─────────────────────────────────────────────
# Runs only after a successful build, so a bumped-but-broken version never
# lands as a pushed commit.
echo ""
if [ "$SKIP_PUSH" = true ]; then
    echo "[4/5] --no-push set - skipping git add/commit/push/tag."
else
    echo "[4/5] Pushing source code to GitHub..."
    git add .

    if git diff --cached --quiet; then
        echo "Nothing to commit, skipping push."
    elif [ "$KEEP_VERSION" = true ]; then
        echo "Version unchanged - amending the last commit."
        git commit --amend --no-edit
        git push --force-with-lease origin main
    else
        git commit -m "$COMMIT_MSG"
        git push origin main
    fi

    TAG="v$NEW_VERSION"
    if git rev-parse "$TAG" >/dev/null 2>&1; then
        echo "WARNING: Tag $TAG already exists locally, skipping tag creation."
    else
        git tag -a "$TAG" -m "Release $TAG"
        git push origin "$TAG"
        echo "Tagged and pushed $TAG"
    fi
fi

# ─── [5/5] Push to Docker Hub ────────────────────────────────────────────────
echo ""
if [ "$SKIP_DOCKER_PUSH" = true ]; then
    echo "=== --no-docker-push set. Image built locally as :latest and :$NEW_VERSION ==="
    exit 0
fi

read -rp "[5/5] Push image to Docker Hub as :latest and :$NEW_VERSION? [Y/n] " PUSH_CONFIRM
if [[ "${PUSH_CONFIRM:-Y}" =~ ^[Yy]$ ]]; then
    docker push "$DOCKER_IMAGE:latest"
    docker push "$DOCKER_IMAGE:$NEW_VERSION"
    echo ""
    echo "=== Done! Pushed as :latest and :$NEW_VERSION ==="
else
    echo ""
    echo "=== Skipped Docker Hub push. Image built locally as :latest and :$NEW_VERSION ==="
fi
