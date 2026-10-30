#!/usr/bin/env bash
# Bundles index.html, styles.css and the scripts into one self-contained page
# (dist/manuscript-tracker.html) for publishing as a claude.ai artifact.
# The artifact host supplies the doctype/html/head/body skeleton, so those tags are dropped.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
awk '
  /<!doctype|<\/?html|<\/?head>|<\/?body>|<meta charset|<meta name="viewport"/ { next }
  /<link rel="stylesheet" href="styles.css">/ {
    print "  <style>"; while ((getline l < "styles.css") > 0) print l; print "  </style>"; next
  }
  /<script src="[^"]+"><\/script>/ {
    f = $0; sub(/.*src="/, "", f); sub(/".*/, "", f)
    print "  <script>"; while ((getline l < f) > 0) print l; print "  </script>"; next
  }
  { print }
' index.html > dist/manuscript-tracker.html
echo "wrote dist/manuscript-tracker.html ($(wc -c < dist/manuscript-tracker.html) bytes)"
