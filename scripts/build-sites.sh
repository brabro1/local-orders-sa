#!/usr/bin/env sh
# Wraps each demo page (demos/<name>.html, written as an artifact fragment) into a
# standalone page at demos/<name>-site/index.html that any static host can serve,
# and copies the demo's photos (demos/img/<name>/) next to it.
set -e
cd "$(dirname "$0")/.."
for src in demos/*.html; do
  name=$(basename "$src" .html)
  out="demos/$name-site/index.html"
  mkdir -p "demos/$name-site"
  {
    printf '%s\n' '<!doctype html>' '<html lang="ar" dir="rtl">' '<head>' '<meta charset="utf-8">' \
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' \
      '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);box-sizing:border-box}[hidden]{display:none!important}img{max-width:100%}</style>' \
      '</head>' '<body>'
    cat "$src"
    printf '\n%s\n%s\n' '</body>' '</html>'
  } > "$out"
  if [ -d "demos/img/$name" ]; then
    rm -rf "demos/$name-site/img" && mkdir -p "demos/$name-site/img" && cp -r "demos/img/$name" "demos/$name-site/img/"
    rm -f "demos/$name-site/img/$name/credits.js.txt"
  fi
  echo "built $out"
done
