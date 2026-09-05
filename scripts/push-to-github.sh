#!/usr/bin/env bash
# Push url-shortener to GitHub (run from a normal terminal after gh auth login)
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v gh &>/dev/null; then
  if [[ -x .bin/gh ]]; then
    GH=.bin/gh
  else
    echo "Install GitHub CLI: https://cli.github.com/"
    exit 1
  fi
else
  GH=gh
fi

$GH auth status || $GH auth login

if git remote get-url origin &>/dev/null; then
  git push -u origin main
else
  $GH repo create url-shortener --public --source=. --remote=origin --push
fi

echo "Done: $($GH repo view --json url -q .url)"
