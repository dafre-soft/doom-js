#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wad_server.py — локальный сервер WAD-файлов для uzDoom / doomApi.

Делает вместо JS всю грязную работу с вадами:
  * сканирует папки и находит *.wad (включая DOOM.WAD в любом регистре);
  * парсит заголовок и directory-таблицу WAD (IWAD/PWAD, E1M1..E4M9, MAP01..MAP32);
  * раздаёт файлы С CORS-заголовками (Access-Control-Allow-Origin: *),
    поэтому doomApi.launch({url:...}) работает без "CORS blocked";
  * отдаёт JSON-список всех найденных вадов на GET /api/wads;
  * умеет скачивать известные IWAD'ы (freedoom/heretic) к вам в папку: --fetch.

Использование (Windows):
    cd C:\\users\\daf\\downloads\\base
    python wad_server.py                  # порт 8090, текущая папка
    python wad_server.py --port 9000 --dir C:\\games\\wads
    python wad_server.py --fetch          # докачать freedoom.wad если нет своих

Потом в браузере (страница игры, Ctrl+F5 после деплоя):
    await doomApi.addWadFromServer('http://127.0.0.1:8090');
    await doomApi.launch({wadId: 'DOOM', levelCode: 'E1M1', maxSpeed: true});
или напрямую:
    await doomApi.launch({url: 'http://127.0.0.1:8090/DOOM.WAD',
                          levelCode: 'E1M1', maxSpeed: true});

Без зависимостей — только стандартная библиотека Python 3.7+.
"""

import argparse
import json
import os
import ssl
import struct
import sys
import urllib.request
from urllib.parse import unquote, parse_qs
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8090

# известные IWAD'ы для --fetch (CORS-friendly зеркала)
DOWNLOADS = [
    ("freedoom1.wad", [
        "https://cdn.jsdelivr.net/gh/free-doombuilders/freedoom@master/freedoom1.wad",
        "https://github.com/free-doombuilders/freedoom/releases/download/v0.12.1/freedoom-0.12.1.wad",
    ]),
    ("heretic.wad", [
        "https://github.com/HereticSuite/HereticSuite/raw/master/heretic.wad",
    ]),
]


# ----------------------------------------------------------------------------- WAD parser

def parse_wad_header(path):
    """Читает заголовок + lump-таблицу. Возвращает dict или None если не WAD."""
    try:
        with open(path, "rb") as f:
            head = f.read(12)
            if len(head) < 12:
                return None
            ident, numlumps, dir_ofs = struct.unpack("<4sII", head)
            if ident not in (b"IWAD", b"PWAD"):
                return None
            size = os.path.getsize(path)
            if dir_ofs == 0 or dir_ofs + numlumps * 16 > size:
                return None
            f.seek(dir_ofs)
            raw = f.read(numlumps * 16)
            lumps = []
            for i in range(numlumps):
                ofs, sz = struct.unpack_from("<II", raw, i * 16)
                name = raw[i * 16 + 8: i * 16 + 16].split(b"\x00")[0]
                try:
                    name = name.decode("ascii")
                except UnicodeDecodeError:
                    name = ""
                lumps.append((name.upper(), ofs, sz))
            return {
                "ident": ident.decode(),
                "numLumps": numlumps,
                "bytes": size,
                "names": set(n for n, _, _ in lumps),
                "levels": sorted(n for n, _, _ in lumps
                                 if (n.startswith("E") and len(n) == 4 and n[1] in "1234"
                                     and n[3] in "123456789") or
                                    (n.startswith("MAP") and len(n) == 5 and n[3:].isdigit())),
            }
    except OSError:
        return None


def guess_profile(info):
    """Профиль по содержимому вада, а не по имени."""
    names = info["names"]
    levels = [l for l in info["levels"] if l.startswith("E") and len(l) == 4]
    episodes = set(l[1] for l in levels)
    # heretic-уровни имеют эпизоды 5..9 (HEXMAP тоже), либо явные маркеры
    if any(l.startswith("HEXMAP") for l in info["levels"]) \
       or "PSTART01" in names or "M7SHIEL" in names \
       or (episodes and episodes >= {"5", "6", "7", "8", "9"}):
        return "heretic"
    if episodes:
        return "doom2" if {"1", "2", "3", "4", "5", "6", "7", "8", "9"} <= episodes else "doom"
    if any(l.startswith("MAP") for l in info["levels"]):
        return "doom2"
    return "doom"


def scan_dir(root):
    """Обход корня (без глубины системных папок) и парсинг всех *.wad."""
    out = []
    seen = set()
    skip_dirs = {".git", "node_modules", "__pycache__", ".gradle", "build", "dist"}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for fn in filenames:
            if not fn.lower().endswith(".wad"):
                continue
            full = os.path.join(dirpath, fn)
            key = os.path.normcase(os.path.abspath(full))
            if key in seen:
                continue
            seen.add(key)
            info = parse_wad_header(full)
            rel = os.path.relpath(full, root).replace("\\", "/")
            entry = {
                "name": os.path.splitext(fn)[0],
                "file": "/" + rel,
                "fileName": fn,
                "absPath": os.path.abspath(full),
                "ok": info is not None,
            }
            if info:
                entry.update({
                    "ident": info["ident"],
                    "numLumps": info["numLumps"],
                    "bytes": info["bytes"],
                    "levels": info["levels"],
                    "profile": guess_profile(info),
                })
            else:
                entry["error"] = "not a valid WAD (or HTML error page saved as .wad)"
            out.append(entry)
    out.sort(key=lambda e: e["name"].lower())
    return out


# ----------------------------------------------------------------------------- HTTP handler

class WadHandler(SimpleHTTPRequestHandler):
    root = "."
    site = None  # папка с index.html (website/) — сервер так же хостит саму игру

    def __init__(self, *a, **kw):
        # SimpleHTTPRequestHandler serves from self.directory; point it at the
        # SITE root so http://127.0.0.1:8090/ opens the game directly.
        super().__init__(*a, directory=self.site or self.root, **kw)

    def translate_path(self, path):
        """Fallback: if a URL isn't found in the site dir, try the WAD dir,
        then search by bare file name anywhere under root (so /DOOM.WAD and
        /website/wads/duom.wad work no matter how the folders are nested)."""
        p = super().translate_path(path)
        if os.path.exists(p):
            return p
        rel = path.lstrip("/").replace("/", os.sep)
        cand = os.path.join(self.root, rel)
        if os.path.isfile(cand):
            return cand
        # /wads/x.wad when root itself is website/ -> already handled above;
        # last resort: match by basename against scanned wad files
        base = os.path.basename(rel).lower()
        for dirpath, _dirs, files in os.walk(self.root):
            for fn in files:
                if fn.lower() == base:
                    return os.path.join(dirpath, fn)
        return p

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _serve_file(self, target):
        """Serve an absolute file path found by our own search (name-based),
        bypassing SimpleHTTPRequestHandler's cached self.path."""
        if not os.path.isfile(target):
            self.send_error(404, "file not found")
            return
        with open(target, "rb") as f:
            data = f.read()
        self.send_response(200)
        ctype = ("application/octet-stream" if target.lower().endswith(".wad")
                 else self.guess_type(target))
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        # /wad/<file> — alias: serve a WAD from the root by file NAME only,
        # so URLs like http://127.0.0.1:8090/wad/DOOM.WAD work no matter how
        # deep the file sits inside the scanned folder tree.
        if path.startswith("/wad/"):
            name = os.path.basename(unquote(path[len("/wad/"):]))
            target = None
            for dirpath, _dirnames, filenames in os.walk(self.root):
                for fn in filenames:
                    if fn.lower() == name.lower():
                        target = os.path.join(dirpath, fn)
                        break
                if target:
                    break
            if target is None:
                self.send_error(404, "no such wad: %s" % name)
                return
            with open(target, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/api/wads":
            data = scan_dir(self.root)
            body = json.dumps({"root": os.path.abspath(self.root), "wads": data},
                              ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/launch":
            # Ready-to-paste JS commands for the browser console.
            q = parse_qs(self.path.split("?")[1] if "?" in self.path else "")
            port = self.server.server_address[1]
            good = [w for w in scan_dir(self.root) if w["ok"]]
            lines = []
            for w in good:
                lvl = (w["levels"][0] if w["levels"] else "E1M1")
                lines.append("await doomApi.launch({wadId: '%s', levelCode: '%s', maxSpeed: true});"
                             % (w["name"].lower(), lvl))
            body = ("// python wad_server.py | root: %s | wads: %d\n"
                    "// Paste into the browser console (after Ctrl+F5):\n%s\n"
                    % (os.path.abspath(self.root), len(good), "\n".join(lines))).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/" and not self.site:
            # No site folder found -> show the WAD dashboard instead of a 404.
            # (When site IS found, "/" falls through to index.html below.)
            data = scan_dir(self.root)
            rows = "".join(
                "<tr><td><a href='%s'>%s</a></td><td>%s</td><td>%s</td><td>%d</td><td>%s</td></tr>"
                % (e["file"], e["fileName"], e.get("ident", "?"), e.get("profile", "?"),
                   e.get("bytes", 0), ", ".join(e.get("levels", [])[:12]))
                for e in data)
            html = ("<html><head><meta charset='utf-8'><title>wad_server</title>"
                    "<style>body{font-family:monospace}td{padding:4px 10px;border-bottom:1px solid #ccc}</style></head>"
                    "<body><h2>WAD server — root: %s</h2>"
                    "<table><tr><th>file</th><th>type</th><th>profile</th><th>bytes</th><th>levels</th></tr>%s</table>"
                    "<p>JS: <code>await doomApi.addWadFromServer('%s');</code></p>"
                    "</body></html>") % (os.path.abspath(self.root), rows, "http://127.0.0.1:%d" % self.server.server_address[1])
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # Last-resort fuzzy match: /duom.wad, /DOOM.WAD, /website/wads/duom.wad
        # all resolve to the real file no matter which folder was passed to --dir.
        base = os.path.basename(unquote(path)).lower()
        if base and "." in base:
            for search_root in [self.site or self.root, self.root]:
                for dirpath, dirnames, filenames in os.walk(search_root):
                    dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
                    for fn in filenames:
                        if fn.lower() == base:
                            self._serve_file(os.path.join(dirpath, fn))
                            return
        super().do_GET()

    def log_message(self, fmt, *args):
        sys.stderr.write("[wad] %s - %s\n" % (self.address_string(), fmt % args))


# ----------------------------------------------------------------------------- fetch known IWADs

def fetch_missing(dest_dir):
    ctx = ssl.create_default_context()
    for fname, urls in DOWNLOADS:
        target = os.path.join(dest_dir, fname)
        if os.path.exists(target) and parse_wad_header(target):
            print("  уже есть: %s" % target)
            continue
        for url in urls:
            try:
                print("  качаю %s ..." % url)
                req = urllib.request.Request(url, headers={"User-Agent": "wad-server"})
                with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
                    data = r.read()
                if data[:4] in (b"IWAD", b"PWAD"):
                    with open(target, "wb") as f:
                        f.write(data)
                    print("  сохранено: %s (%d байт)" % (target, len(data)))
                    break
                else:
                    print("  ! не WAD по адресу %s (получен HTML?) — пробую следующее зеркало" % url)
            except Exception as e:
                print("  ! %s -> %s" % (url, e))


# ----------------------------------------------------------------------------- main

def find_site_root(root):
    """Ищем корень сайта (папку с index.html) рядом с --dir / текущей папкой.

    Порядок: сама папка --dir, её родители, ./website, затем подпапки на два
    уровня вглубь (например repo/website/index.html). Первый найденный — сайт."""
    candidates = []
    p = os.path.abspath(root)
    for _ in range(4):
        candidates.append(p)
        parent = os.path.dirname(p)
        if parent == p:
            break
        p = parent
    candidates.append(os.path.join(os.path.abspath(root), "website"))
    here = os.path.dirname(os.path.abspath(__file__))
    candidates += [here, os.path.join(here, "website")]
    for c in candidates:
        if os.path.isfile(os.path.join(c, "index.html")):
            return c
    # deep search under --dir and the script folder (skip heavy dirs)
    skip = {".git", "node_modules", "__pycache__", ".venv", "venv"}
    for base in (os.path.abspath(root), here):
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in skip]
            if "index.html" in filenames:
                return dirpath
            if dirpath.count(os.sep) - base.count(os.sep) >= 2:
                dirnames[:] = []  # limit depth to 2 levels
    return None


def main():
    repo_here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Local CORS-enabled WAD + site server for doomApi")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--dir", default=".", help="папка со WAD-файлами (по умолчанию — корень репозитория/текущая)")
    ap.add_argument("--site", default=None,
                    help="корень сайта (папка с index.html). По умолчанию авто: website/ рядом со скриптом.")
    ap.add_argument("--fetch", action="store_true", help="скачать известные IWAD'ы в --dir")
    ap.add_argument("--scan", action="store_true", help="только показать список вадов и выйти")
    args = ap.parse_args()

    # --dir по умолчанию: если в текущей папке нет .wad, но есть в ./website/wads — берём корень репозитория
    root = os.path.abspath(args.dir)
    if args.dir == ".":
        if not scan_dir(root) and (os.path.isdir(os.path.join(repo_here, "website"))):
            root = repo_here
    if not os.path.isdir(root):
        print("нет папки: %s" % root)
        sys.exit(1)

    if args.fetch:
        print("Скачивание известных IWAD в %s:" % root)
        fetch_missing(root)

    site = os.path.abspath(args.site) if args.site else (find_site_root(root) or find_site_root(repo_here))
    if site and not os.path.isfile(os.path.join(site, "index.html")):
        site = None

    WadHandler.root = root
    WadHandler.site = site
    os.chdir(root)

    wads = scan_dir(root)
    good = [w for w in wads if w["ok"]]
    bad = [w for w in wads if not w["ok"]]
    print("=" * 70)
    print("wad_server | root: %s | найдено WAD: %d" % (root, len(good)))
    for w in good:
        lv = ", ".join(w["levels"][:8]) + ("…" if len(w["levels"]) > 8 else "")
        print("  %-24s %s profile=%-8s уровни: %s" % (w["fileName"], w["ident"], w["profile"], lv))
    for w in bad:
        print("  %-24s !!! %s" % (w["fileName"], w["error"]))
    if not good:
        print("  (нет ни одного корректного .wad — положите файлы в эту папку или запустите с --fetch)")
    print("=" * 70)

    if args.scan:
        return

    srv = ThreadingHTTPServer(("0.0.0.0", args.port), WadHandler)
    print("URL для doomApi:")
    for w in good:
        print("  http://127.0.0.1:%d%s   (wadId: '%s')" % (args.port, w["file"], w["name"]))
    if site:
        print("САЙТ игры: http://127.0.0.1:%d/  (открой и играй — index.html найден)" % args.port)
    else:
        print("!!! index.html не найден — запусти из корня репозитория или укажи --site <папка с index.html>")
    print("\nВ консоли браузера (после Ctrl+F5):")
    print("  await doomApi.addWadFromServer('http://127.0.0.1:%d');" % args.port)
    if good:
        first = good[0]
        lvl = (first["levels"][0] if first["levels"] else "E1M1")
        print("  await doomApi.launch({wadId: '%s', levelCode: '%s', maxSpeed: true});"
              % (first["name"], lvl))
    print("\nCtrl+C — остановить.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nостановлен.")


if __name__ == "__main__":
    main()
