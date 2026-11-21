#!/bin/sh
# Copies the two project folders in bench/templates into bench/fixtures and makes each a git
# repository, so the kit finds their .claude folders as project settings. Run it once before the bench.
set -e
here=$(cd "$(dirname "$0")" && pwd)
rm -rf "$here/fixtures"
mkdir -p "$here/fixtures"
for name in watch-house broken-house; do
  cp -R "$here/templates/$name" "$here/fixtures/$name"
  git -C "$here/fixtures/$name" init -q -b main
done
