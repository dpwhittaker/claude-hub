#!/usr/bin/env bash
# Serve this Jekyll site locally the way GitHub Pages renders it: same minima
# theme, same kramdown, same "/<NAME>" baseurl, so the local preview matches a
# deploy. claude-hub reverse-proxies this at /<NAME>/ (stripPrefix: false), so
# the baseurl is required.
#
#   ./serve-local.sh          # serve at http://127.0.0.1:<PORT>/<NAME>/
#   ./serve-local.sh 4010     # custom port
#
# Runs in the foreground so systemd (jekyll@<NAME>.service) can manage it. Uses
# Gemfile.local (invisible to the GitHub Pages build, which looks for a file
# named literally "Gemfile") and a project-local vendor/bundle, so nothing here
# changes how the live site is built.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-<PORT>}"
export BUNDLE_GEMFILE=Gemfile.local
exec bundle exec jekyll serve \
  --baseurl /<NAME> \
  --host 127.0.0.1 --port "$PORT"
