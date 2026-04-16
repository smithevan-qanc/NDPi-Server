#!/usr/bin/env bash
set -e

BRANCH="$(head -n 1 version-git.txt)"

cd "$(dirname "$0")"
git fetch origin $BRANCH

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/$BRANCH)

if [ "$LOCAL" != "$REMOTE" ]; then
    git reset --hard origin/$BRANCH
fi