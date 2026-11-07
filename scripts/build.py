"""Builds the whole public site into _site/, the same tree GitHub Pages serves.

    demos/index.html          -> _site/index.html          (list of all demos)
    demos/<name>.html         -> _site/<name>/index.html   (demo written as an artifact fragment,
                                                            wrapped into a full page here)
    demos/img/<name>/         -> _site/<name>/img/<name>/  (that demo's photos)
    demos/<folder>/index.html -> _site/<folder>/           (a full app, copied as is, e.g. laundry-pwa)

A new demo needs no change here: add demos/<name>.html or a demos/<folder>/ and it is built.
Never edit _site/ by hand; it is deleted and rebuilt every time (and is not committed).

Usage:
    python scripts/build.py              build only
    python scripts/build.py --serve      build, then serve on http://localhost:8765
    python scripts/build.py --serve 9000 build, then serve on another port
"""
import functools
import hashlib
import http.server
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEMOS = ROOT / "demos"
OUT = ROOT / "_site"

HEAD = (
    '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    "<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);"
    "box-sizing:border-box}[hidden]{display:none!important}img{max-width:100%}</style>\n"
    "</head>\n<body>\n"
)
TAIL = "\n</body>\n</html>\n"
SKIP_IN_APPS = {"README.md", "_headers"}


def folder_checksum(folder: Path) -> str:
    h = hashlib.sha1()
    for f in sorted(p for p in folder.rglob("*") if p.is_file() and p.name not in SKIP_IN_APPS):
        h.update(f.relative_to(folder).as_posix().encode())
        h.update(f.read_bytes().replace(b"\r\n", b"\n"))  # same result on Windows and Linux
    return h.hexdigest()[:10]


def build() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    shutil.copyfile(DEMOS / "index.html", OUT / "index.html")

    # Fragment demos: wrap each in a standalone page.
    for src in sorted(DEMOS.glob("*.html")):
        name = src.stem
        if name == "index":
            continue
        dest = OUT / name
        dest.mkdir()
        body = src.read_text(encoding="utf-8")
        (dest / "index.html").write_text(HEAD + body + TAIL, encoding="utf-8", newline="\n")
        photos = DEMOS / "img" / name
        if photos.is_dir():
            shutil.copytree(photos, dest / "img" / name, ignore=shutil.ignore_patterns("credits.js.txt"))
        print(f"built _site/{name}/")

    # Full apps: copy the folder. If it has a service worker, stamp its cache VERSION with a
    # checksum of the folder, so phones pick up every change without anyone bumping it by hand.
    for folder in sorted(p for p in DEMOS.iterdir() if p.is_dir()):
        if folder.name == "img" or not (folder / "index.html").is_file():
            continue
        dest = OUT / folder.name
        shutil.copytree(folder, dest, ignore=shutil.ignore_patterns(*SKIP_IN_APPS))
        sw = dest / "sw.js"
        if sw.is_file():
            version = f"{folder.name}-{folder_checksum(folder)}"
            text = sw.read_text(encoding="utf-8")
            text, count = re.subn(r"const VERSION = '[^']*'", f"const VERSION = '{version}'", text)
            if count != 1:
                sys.exit(f"{folder.name}/sw.js: expected one line like  const VERSION = '...';")
            sw.write_text(text, encoding="utf-8", newline="\n")
        print(f"built _site/{folder.name}/ (app)")


def serve(port: int) -> None:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(OUT))
    print(f"serving _site/ on http://localhost:{port}  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()


if __name__ == "__main__":
    build()
    if "--serve" in sys.argv:
        i = sys.argv.index("--serve")
        port = int(sys.argv[i + 1]) if len(sys.argv) > i + 1 else 8765
        serve(port)
