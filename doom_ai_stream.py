#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
doom_ai_stream.py — отдельная херня с ИИшкой, панелью управления и трансляцией DOOMa.

Всё в одном файле, ничего не трогает в doom_neat.py:

  1) поднимается ПАНЕЛЬ УПРАВЛЕНИЯ + ТРАНСЛЯЦИЯ на http://localhost:8090
     (stdlib http.server, без flask; MultipartJet-стрим кадров, JSON-API,
      живые метрики, чат с ИИшкой, управление игрой)
  2) затем стартует игровой сервер (сайт spipu-doom + /api/wads), по умолчанию :8123
  2b) отдельный СЫРОЙ КАМЕРЫ сервер на http://localhost:8125 — только картинка
      DOOMa без всякого UI панели: /            — одна страница <img>,
      /raw.jpg        — свежий JPEG-кадр (можно тыкать в VLC/ffmpeg/OBS),
      /raw.mjpg       — multipart/x-mixed-replace видеопоток,
      /frame.png      — PNG-версия кадра
  3) Playwright Chromium открывает сайт и дёргает window.doomApi
     (waitReady / launch / getView / setMove / setInput / screenshot / draw)
  4) ИИШКА: нейросеть-политика (numpy MLP, ReLU, softmax над действиями).
     Мозг эволюционирует онлайн (эволюционное обучение в стиле NEAT/CMA-lite):
     после каждого эпизода агент получает fitness (выживание, движение,
     пикапы, урон, смерть) и популяция мозгов смещается к лучшим.
     Мозги сохраняются в .ai_stream_state/brains.json.gz.
     Есть и ручной режим (руль на панели / WASD).

Трансляция: страница на :8090 показывает живой кадр игры (doomApi.screenshot()
через Playwright, ~25 fps), HUD (позиция, здоровье, броня, оружие, патроны),
миникарту things, текущий мозг (веса), лог действий агента и чат с ИИшкой.

Зависимости (ставятся сами при запуске, если чего-то не хватает):
    pip install playwright numpy && python -m playwright install chromium

Запуск:
    python doom_ai_stream.py                 # панель :8090, игра :8123, сырая камера :8125
    python doom_ai_stream.py --port 8090 --game-port 8123 --raw-port 8125 --wad freedoom1 --level E1M1
    python doom_ai_stream.py --no-browser    # только панель, браузер вручную
"""

import argparse
import base64
import gzip
import io
import json
import math
import os
import pickle
import random
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ----------------------------------------------------------------------------- deps bootstrap

def ensure_dependencies():
    try:
        import importlib.util as iu
    except Exception:
        iu = None
    missing = []
    if iu is not None:
        for m in ("playwright", "numpy"):
            if iu.find_spec(m) is None:
                missing.append(m)
    else:
        missing = ["playwright", "numpy"]
    if missing or True:
        # даже если модули есть, проверим что playwright реально импортируется
        try:
            from playwright.sync_api import sync_playwright  # noqa
            import numpy  # noqa
            missing = []
        except Exception:
            pass
    if missing:
        print("Ставлю зависимости: %s" % ", ".join(missing), flush=True)
        cmd = [sys.executable, "-m", "pip", "install", "--quiet"] + missing
        subprocess.check_call(cmd)
        try:
            from playwright.sync_api import sync_playwright  # noqa
            have_browser = False
            try:
                with sync_playwright() as p:
                    b = p.chromium.launch(headless=True)
                    b.close()
                    have_browser = True
            except Exception:
                have_browser = False
            if not have_browser:
                print("Ставлю chromium для playwright…", flush=True)
                subprocess.check_call([sys.executable, "-m", "playwright", "install", "chromium"])
        except Exception as e:
            print("Не удалось проверить браузер: %s" % e, flush=True)


ensure_dependencies()

import numpy as np  # noqa: E402

# ----------------------------------------------------------------------------- paths & constants

HERE       = os.path.dirname(os.path.abspath(__file__))
SITE_DIR   = os.path.join(HERE, "website")
STATE_DIR  = os.path.join(HERE, ".ai_stream_state")
BRAIN_PATH = os.path.join(STATE_DIR, "brains.json.gz")

STREAM_HOST = os.environ.get("AI_STREAM_HOST", "0.0.0.0")
STREAM_PORT = 8090          # панель управления + трансляция
GAME_HOST   = "127.0.0.1"
GAME_PORT   = 8123          # игровой сервер (сайт spipu-doom)
RAW_HOST    = os.environ.get("AI_RAW_HOST", "0.0.0.0")
RAW_PORT    = 8125          # сырая камера DOOMa (без UI панели)
_raw_httpd  = None          # экземпляр сервера сырой камеры (для рестарта на др. порту)

ACTIONS = ["idle", "forward", "back", "strafe_left", "strafe_right",
           "turn_left", "turn_right", "run", "use", "attack"]
# действие -> (moveX, moveY, lookYaw deg, button)
ACTION_TABLE = {
    "idle":        (0.0, 0.0, 0.0, None),
    "forward":     (0.0, 1.0, 0.0, None),
    "back":        (0.0, -1.0, 0.0, None),
    "strafe_left": (-1.0, 0.0, 0.0, None),
    "strafe_right":(1.0, 0.0, 0.0, None),
    "turn_left":   (0.0, 0.0, -22.0, None),
    "turn_right":  (0.0, 0.0, 22.0, None),
    "run":         (0.0, 1.0, 0.0, "run"),
    "use":         (0.0, 0.0, 0.0, "use"),
    "attack":      (0.0, 0.0, 0.0, "attack"),
}

ENEMY_HINTS = {"monster", "enemy", "baron", "knight", "imp", "demon", "caco",
               "shotgun", "zombie", "soldier", "sergeant", "hell", "pain",
               "lost", "archvile", "arachno"}
ITEM_HINTS  = {"item", "pickup", "powerup", "health", "armor", "ammo", "weapon"}

OBS_KEYS = ["x", "y", "health", "armor", "dead", "vx", "vy", "ammo", "angle_to_enemy"]

LEVEL_RE = re.compile(r"^(E\dM\d|MAP\d\d)$")

DOWNLOADS = [
    ("freedoom1.wad", [
        "https://distro.ibiblio.org/rootplex/dooM/freedoom1.wad",
        "https://github.com/free-doombuilders/freedoom/releases/download/v0.12.1/freedoom-0.12.1.wad",
    ]),
    ("freedoom2.wad", [
        "https://distro.ibiblio.org/rootplex/dooM/freedoom2.wad",
        "https://github.com/free-doombuilders/freedoom/releases/download/v0.12.1/freedoom-0.12.1.wad",
    ]),
]


def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def clamp(v, lo=-1.0, hi=1.0):
    return max(lo, min(hi, v))


def port_is_free(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) != 0


# ----------------------------------------------------------------------------- wad helpers

def parse_wad_header(path):
    try:
        size = os.path.getsize(path)
        if size < 12:
            return None
        with open(path, "rb") as f:
            ident = f.read(4)
            if ident not in (b"IWAD", b"PWAD"):
                return None
            count = int.from_bytes(f.read(4), "little")
            f.read(4)
            if count <= 0 or count > 100000:
                return None
            dir_off = size - 8 * (count + 1)
            if dir_off < 12:
                return None
            names = []
            for i in range(count):
                f.seek(dir_off + i * 8)
                nm = f.read(8).rstrip(b"\x00").decode("ascii", "ignore")
                names.append(nm)
            levels = []
            for j, nm in enumerate(names[:-1]):
                nxt = names[j + 1]
                if nm.upper() == "E1M1" and nxt[:2].upper() in ("E2", "E3", "E4"):
                    break
                if LEVEL_RE.match(nm.upper()):
                    levels.append(nm.upper())
            return {"ident": ident.decode(), "numLumps": count, "bytes": size, "levels": levels}
    except Exception:
        return None


def scan_wads():
    out = []
    skip = {".git", "node_modules", "__pycache__", ".neat_doom_state", ".ai_stream_state"}
    for dirpath, dirnames, filenames in os.walk(HERE):
        dirnames[:] = [d for d in dirnames if d not in skip]
        for fn in filenames:
            if not fn.lower().endswith(".wad"):
                continue
            full = os.path.join(dirpath, fn)
            info = parse_wad_header(full)
            url = None
            if os.path.abspath(full).startswith(os.path.abspath(SITE_DIR)):
                url = "/" + os.path.relpath(full, SITE_DIR).replace("\\", "/")
            entry = {"name": os.path.splitext(fn)[0], "fileName": fn, "url": url,
                     "absPath": full, "ok": info is not None}
            if info:
                entry.update(info)
            out.append(entry)
    # известные вады, которых нет на диске — чтобы кнопка «скачать» была
    known_names = {e["fileName"].lower() for e in out}
    for fname, urls in DOWNLOADS:
        if fname.lower() not in known_names:
            out.append({"name": os.path.splitext(fname)[0], "fileName": fname,
                        "url": None, "absPath": None, "ok": False, "downloadable": True,
                        "urls": urls})
    out.sort(key=lambda e: e["name"].lower())
    return out


def download_wad(fname, urls, dest_dir):
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, fname)
    last_err = None
    for url in urls:
        try:
            tmp = dest + ".part"
            urllib.request.urlretrieve(url, tmp)
            if parse_wad_header(tmp) is None:
                raise ValueError("не похож на WAD: %s" % url)
            shutil.move(tmp, dest)
            return {"ok": True, "file": dest}
        except Exception as e:
            last_err = "%s -> %s" % (url, e)
    return {"ok": False, "error": last_err or "все зеркала недоступны"}


# ----------------------------------------------------------------------------- the AI brain (numpy MLP)

def relu(x):
    return np.maximum(0.0, x)


class Brain:
    """Маленький MLP: obs -> hidden(ReLU) -> logits(action) + yaw_delta."""

    def __init__(self, n_in, n_hidden=24, n_actions=None, rng=None, weights=None):
        self.n_in = int(n_in)
        self.n_hidden = int(n_hidden)
        self.n_actions = n_actions or len(ACTIONS)
        r = rng or np.random.default_rng()
        if weights is not None:
            self.W1, self.b1, self.W2, self.b2 = weights
        else:
            self.W1 = r.normal(0, 0.8, (self.n_in, self.n_hidden))
            self.b1 = r.normal(0, 0.2, (self.n_hidden,))
            self.W2 = r.normal(0, 0.5, (self.n_hidden, self.n_actions + 1))  # +1 = delta yaw
            self.b2 = np.zeros(self.n_actions + 1)

    def forward(self, obs):
        h = relu(self.W1.T @ obs + self.b1)
        out = self.W2.T @ h + self.b2
        return out

    def act(self, obs, explore=True, temperature=1.0):
        out = self.forward(obs)
        logits = out[:self.n_actions]
        yaw = float(np.tanh(out[self.n_actions]) * 25.0)
        probs = np.exp((logits - logits.max()) * max(0.05, temperature))
        probs = probs / probs.sum()
        if explore:
            action = int(np.random.choice(self.n_actions, p=probs))
        else:
            action = int(logits.argmax())
        return action, yaw, probs

    def genome(self):
        return [self.W1.tolist(), self.b1.tolist(), self.W2.tolist(), self.b2.tolist()]

    @staticmethod
    def from_genome(g):
        return Brain(len(g[0]), len(g[0][0]), len(g[2][0]) - 1,
                     weights=[np.array(g[0]), np.array(g[1]), np.array(g[2]), np.array(g[3])])

    def cloned(self):
        return Brain(self.n_in, self.n_hidden, self.n_actions,
                     weights=[self.W1.copy(), self.b1.copy(), self.W2.copy(), self.b2.copy()])


def mutate(brain, rate=0.15, power=0.4, rng=None):
    r = rng or np.random.default_rng()
    b = brain.cloned()
    for W, name in ((b.W1, "W1"), (b.W2, "W2")):
        mask = r.random(W.shape) < rate
        W += mask * r.normal(0, power, W.shape)
    b.b1 += (r.random(b.b1.shape) < rate) * r.normal(0, power, b.b1.shape)
    b.b2 += (r.random(b.b2.shape) < rate) * r.normal(0, power, b.b2.shape)
    return b


class Population:
    """Эволюционное население мозгов: elites + мутанты + немного свежака."""

    def __init__(self, n_in, size=12, hidden=24, seed=None):
        self.rng = np.random.default_rng(seed)
        self.py_rng = random.Random(seed if seed is None else int(seed))
        self.n_in = n_in
        self.size = size
        self.hidden = hidden
        self.brains = [Brain(n_in, hidden, rng=self.rng) for _ in range(size)]
        self.generation = 0
        self.history = []          # [{gen, best, avg}]
        self.best_ever = None
        self.current_idx = 0

    def pick_next(self):
        self.current_idx = self.py_rng.randrange(len(self.brains))
        return self.brains[self.current_idx]

    def update(self, fitnesses):
        """fitnesses: list[float] по self.brains. Возвращает best fitness."""
        pairs = sorted(zip(fitnesses, range(len(self.brains))), reverse=True)
        best_fit = pairs[0][0]
        avg = sum(fitnesses) / max(1, len(fitnesses))
        self.generation += 1
        self.history.append({"gen": self.generation, "best": round(best_fit, 2),
                             "avg": round(avg, 2)})
        self.history = self.history[-200:]
        if self.best_ever is None or best_fit > self.best_ever["fit"]:
            self.best_ever = {"fit": best_fit, "gen": self.generation,
                              "genome": self.brains[pairs[0][1]].genome()}
        n_elite = max(1, self.size // 4)
        new = [self.brains[i].cloned() for _, i in pairs[:n_elite]]
        while len(new) < self.size:
            if self.py_rng.random() < 0.75 and len(pairs) >= 2:
                a = pairs[self.py_rng.randrange(min(4, len(pairs)))][1]
                child = mutate(self.brains[a], rng=self.rng)
            else:
                child = Brain(self.n_in, self.hidden, rng=self.rng)
            new.append(child)
        self.brains = new
        return best_fit

    def to_json(self):
        return {"n_in": self.n_in, "hidden": self.hidden, "size": self.size,
                "generation": self.generation, "history": self.history,
                "best_ever": self.best_ever,
                "brains": [b.genome() for b in self.brains]}

    @staticmethod
    def from_json(d):
        p = Population(d["n_in"], d.get("size", 12), d.get("hidden", 24))
        p.generation = d.get("generation", 0)
        p.history = d.get("history", [])
        p.best_ever = d.get("best_ever")
        brains = [Brain.from_genome(g) for g in d.get("brains", [])]
        if brains:
            p.brains = brains
        return p


def save_population(pop):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with gzip.open(BRAIN_PATH + ".tmp", "wt", encoding="utf-8") as f:
            json.dump(pop.to_json(), f)
        shutil.move(BRAIN_PATH + ".tmp", BRAIN_PATH)
        return {"ok": True, "path": BRAIN_PATH, "gen": pop.generation}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def load_population(n_in):
    try:
        with gzip.open(BRAIN_PATH, "rt", encoding="utf-8") as f:
            d = json.load(f)
        if d.get("n_in") != n_in:
            return None
        return Population.from_json(d)
    except FileNotFoundError:
        return None
    except Exception:
        return None


# ----------------------------------------------------------------------------- observation

def nearest_by_kind(things, hints, px, py, yaw):
    best = None
    bd = 1e18
    for t in things:
        kind = str(t.get("kind", "")).lower()
        if not any(h in kind for h in hints):
            continue
        dx = float(t.get("x", 0)) - px
        dy = float(t.get("y", 0)) - py
        d = math.hypot(dx, dy)
        if d < bd:
            bd = d
            best = (dx, dy, d, kind)
    return best


def build_observation(view, stats):
    """Нормализованный вектор наблюдений + сырые данные для наград."""
    p = view.get("player", {})
    things = view.get("things", []) or []
    px, py = float(p.get("x", 0)), float(p.get("y", 0))
    yaw = float(p.get("yaw", 0))
    health = float(p.get("health", 0))
    armor = float(p.get("armor", 0))
    dead = 1.0 if p.get("dead") else 0.0
    vel = p.get("velocity", [0, 0])
    vx, vy = (float(vel[0]), float(vel[1])) if isinstance(vel, (list, tuple)) and len(vel) >= 2 else (0.0, 0.0)
    ammo = p.get("ammo", {})
    acur = float(ammo.get("current", 0) if isinstance(ammo, dict) else (ammo or 0))

    enemy = nearest_by_kind(things, ENEMY_HINTS, px, py, yaw)
    item = nearest_by_kind(things, ITEM_HINTS, px, py, yaw)
    ang_to_enemy = 0.0
    if enemy is not None:
        ang_to_enemy = math.atan2(enemy[1], enemy[0]) - math.radians(yaw)

    feats = [px, py, health, armor, dead, vx, vy, acur / 50.0,
             math.sin(ang_to_enemy), math.cos(ang_to_enemy),
             (enemy[2] / 2000.0) if enemy else 1.0, 1.0 if enemy else 0.0,
             (item[2] / 2000.0) if item else 1.0, 1.0 if item else 0.0]
    raw = {"x": px, "y": py, "health": health, "armor": armor, "dead": bool(p.get("dead")),
           "enemy": enemy, "item": item, "level": view.get("levelCode"),
           "yaw": yaw}
    # online normalization
    if stats is not None:
        for i, v in enumerate(feats):
            m, sd = stats[i]
            stats[i] = (0.99 * m + 0.01 * v, math.sqrt(0.99 * (sd ** 2) + 0.01 * (v - m) ** 2) or 1.0)
        feats = [clamp((v - stats[i][0]) / stats[i][1], -6, 6) for i, v in enumerate(feats)]
    return raw, feats


FEATURE_COUNT = 14


# ----------------------------------------------------------------------------- game static server

class GameServer:
    def __init__(self, state):
        self.state = state
        self.httpd = None
        self.thread = None
        self.port = GAME_PORT

    def start(self, port=None):
        if self.httpd is not None:
            return {"ok": True, "already": True, "port": self.port}
        p = int(port or self.port)
        if not port_is_free(GAME_HOST, p):
            return {"ok": False, "error": "порт %d занят" % p}
        site = SITE_DIR
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                pass

            def _json(self, obj, code=200):
                body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
                if path == "/api/wads":
                    self._json({"site": site, "wads": scan_wads()})
                    return
                if path.startswith("/api/"):
                    self._json({"error": "no such api"}, 404)
                    return
                rel = (path.lstrip("/") or "index.html").split("?")[0]
                target = os.path.normpath(os.path.join(site, rel))
                if not target.startswith(os.path.abspath(site)):
                    self.send_error(403)
                    return
                if not os.path.isfile(target):
                    self.send_error(404)
                    return
                ctype = "text/html; charset=utf-8"
                low = target.lower()
                for suf, t in ((".js", "text/javascript; charset=utf-8"), (".css", "text/css"),
                               (".json", "application/json"), (".webmanifest", "application/json"),
                               (".png", "image/png"), (".jpg", "image/jpeg"), (".svg", "image/svg+xml"),
                               (".ico", "image/x-icon"), (".woff2", "font/woff2"),
                               (".wad", "application/octet-stream")):
                    if low.endswith(suf):
                        ctype = t
                        break
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Length", str(os.path.getsize(target)))
                self.end_headers()
                with open(target, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)

        try:
            self.httpd = ThreadingHTTPServer((GAME_HOST, p), Handler)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        self.port = p
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        outer.state.log("игровой сервер: http://%s:%d (сайт spipu-doom)" % (GAME_HOST, p))
        return {"ok": True, "port": p, "url": "http://%s:%d/" % (GAME_HOST, p)}

    def stop(self):
        if self.httpd is not None:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None
            self.thread = None
        return {"ok": True}


# ----------------------------------------------------------------------------- browser bridge (window.doomApi)

LAUNCH_JS_TMPL = """
async () => {
  const opts = %s;
  await doomApi.waitReady({timeoutMs: 180000});
  if (window.__AI_STREAM__ && window.__AI_STREAM__.running) {
    try { doomApi.stop(); } catch (e) {}
  }
  window.__AI_STREAM__ = {running: true};
  try {
    await doomApi.launch(opts);
    window.__AI_STREAM__.launchErr = null;
  } catch (e) {
    window.__AI_STREAM__.launchErr = String(e && e.message || e);
  }
  return window.__AI_STREAM__;
}
"""

MARK_JS = """
(targets) => {
  if (!window.doomApi || !doomApi.draw) return false;
  window.__AI_STREAM_MARKS__ = targets;
  if (!window.__AI_STREAM_DRAW__) {
    window.__AI_STREAM_DRAW__ = (ctx, info) => {
      const ts = window.__AI_STREAM_MARKS__ || [];
      ctx.save();
      ctx.lineWidth = 2;
      ctx.font = '12px monospace';
      for (const t of ts) {
        if (t.sx < 0 || t.sy < 0) continue;
        const col = t.enemy ? '#ff4040' : (t.item ? '#40ff80' : '#40a0ff');
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.arc(t.sx, t.sy, Math.max(6, 40 - t.depth / 60), 0, 6.2832);
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.fillText(t.kind, t.sx + 8, t.sy - 8);
      }
      ctx.restore();
    };
    doomApi.draw(window.__AI_STREAM_DRAW__);
  }
  return true;
}
"""

# снимает СЫРОЙ кадр прямо с canvas'а DOOMa (тот же буфер, что рисует игра,
# но без оверлея целей и без UI панели)
RAW_FRAME_JS = """
(o) => {
  try {
    const sel = ['canvas#doom-canvas', 'canvas#game', '#doom-game canvas',
                 '.doom-canvas', '#app canvas', 'canvas'];
    let cv = null;
    for (const s of sel) { try { cv = document.querySelector(s); if (cv) break; } catch (e) {} }
    if (!cv) {
      const all = Array.from(document.querySelectorAll('canvas'));
      all.sort((a, b) => (b.width * b.height) - (a.width * a.height));
      cv = all[0] || null;
    }
    if (!cv || !cv.width || !cv.height) return null;
    const scale = Math.min(1, (o.w || 1280) / cv.width);
    const tmp = document.createElement('canvas');
    tmp.width  = Math.max(1, Math.round(cv.width * scale));
    tmp.height = Math.max(1, Math.round(cv.height * scale));
    const ctx = tmp.getContext('2d');
    ctx.imageSmoothingEnabled = false;   // пиксель-арт как есть
    ctx.drawImage(cv, 0, 0, tmp.width, tmp.height);
    const mime = (o.mime === 'image/png') ? 'image/png' : 'image/jpeg';
    return tmp.toDataURL(mime, o.q || 0.8);
  } catch (e) { return null; }
}
"""


class Browser:
    def __init__(self, state):
        self.state = state
        self.playwright = None
        self.browser = None
        self.page = None
        self.lock = threading.Lock()
        self.frame_jpeg = None          # кадр с оверлеем целей (для панели)
        self.frame_ts = 0.0
        self.raw_jpeg = None            # СЫРОЙ кадр canvas'а DOOMa без UI панели
        self.raw_ts = 0.0
        self.view_data = None
        self.stream_enabled = True

    def available(self):
        try:
            from playwright.sync_api import sync_playwright  # noqa
            return True
        except Exception:
            return False

    def page_ready(self):
        with self.lock:
            return self.page is not None

    def open_site(self, url, headless=True):
        from playwright.sync_api import sync_playwright
        with self.lock:
            if self.playwright is None:
                self.playwright = sync_playwright().start()
                self.browser = self.playwright.chromium.launch(headless=bool(headless))
                self.page = self.browser.new_page(viewport={"width": 960, "height": 540})
            self.page.goto(url, wait_until="domcontentloaded", timeout=60000)
            return {"ok": True, "url": url}

    def launch_game(self, opts):
        with self.lock:
            if self.page is None:
                raise RuntimeError("браузер не открыт")
            js = LAUNCH_JS_TMPL % json.dumps(opts)
            return self.page.evaluate(js)

    def snapshot(self):
        with self.lock:
            if self.page is None:
                return None
            try:
                view = self.page.evaluate(
                    "() => (window.doomApi && doomApi.getView()) ? doomApi.getView() : null")
            except Exception:
                return None
            if view is not None:
                self.view_data = view
            return view

    def set_action(self, idx, yaw_delta=0.0):
        name = ACTIONS[idx] if 0 <= idx < len(ACTIONS) else "idle"
        mx, my, lyaw, btn = ACTION_TABLE[name]
        payload = {"mx": mx, "my": my, "yaw": float(yaw_delta) + lyaw, "btn": btn}
        with self.lock:
            if self.page is None:
                return
            try:
                self.page.evaluate(
                    """(d) => {
                        try {
                          doomApi.stopMovement();
                          doomApi.setMove(d.mx, d.my, d.yaw, 0);
                          if (d.btn === 'run') doomApi.setInput('run', true);
                          if (d.btn === 'use')  { doomApi.setInput('use', true);
                              setTimeout(() => { try { doomApi.setInput('use', false); } catch(e){} }, 120); }
                          if (d.btn === 'attack'){ doomApi.setInput('attack', true);
                              setTimeout(() => { try { doomApi.setInput('attack', false); } catch(e){} }, 100); }
                        } catch (e) {}
                    }""", payload)
            except Exception as e:
                self.state.log("set_action: %s" % e)

    def drive_manual(self, mx, my, yaw, keys):
        with self.lock:
            if self.page is None:
                return
            try:
                self.page.evaluate(
                    """(d) => {
                        try {
                          doomApi.setMove(d.mx, d.my, d.yaw, 0);
                          for (const k of ['run','use','attack'])
                            doomApi.setInput(k, d.keys.indexOf(k) >= 0);
                        } catch (e) {}
                    }""", {"mx": mx, "my": my, "yaw": yaw, "keys": list(keys)})
            except Exception:
                pass

    def mark_targets(self, marks):
        with self.lock:
            if self.page is None:
                return
            try:
                self.page.evaluate(MARK_JS, marks)
            except Exception:
                pass

    def grab_frame(self, quality=0.55, max_width=720, min_interval=0.04):
        if not self.stream_enabled:
            return
        now = time.time()
        if now - self.frame_ts < min_interval:
            return
        with self.lock:
            if self.page is None:
                return
            try:
                data_url = self.page.evaluate(
                    "() => { try { return (window.doomApi && doomApi.screenshot)"
                    " ? doomApi.screenshot('image/jpeg', %.2f) : null; } catch (e) { return null; } }"
                    % quality)
            except Exception:
                return
        if not data_url or not isinstance(data_url, str) or "," not in data_url:
            return
        try:
            raw = base64.b64decode(data_url.split(",", 1)[1])
            self.frame_jpeg = raw
            self.frame_ts = time.time()
        except Exception:
            pass

    def grab_raw_frame(self, quality=0.8, max_width=1280, min_interval=0.05):
        """Снимает СЫРОЙ кадр прямо с canvas'а DOOMa (без оверлеев панели/целей)."""
        now = time.time()
        if now - self.raw_ts < min_interval:
            return
        with self.lock:
            if self.page is None:
                return
            try:
                data_url = self.page.evaluate(RAW_FRAME_JS, {"q": quality, "w": max_width})
            except Exception:
                return
        if not data_url or not isinstance(data_url, str) or "," not in data_url:
            return
        try:
            self.raw_jpeg = base64.b64decode(data_url.split(",", 1)[1])
            self.raw_ts = time.time()
        except Exception:
            pass

    def grab_png_frame(self, max_width=1280):
        """PNG-версия сырого кадра (для /frame.png на сервере камеры)."""
        with self.lock:
            if self.page is None:
                return None
            try:
                data_url = self.page.evaluate(RAW_FRAME_JS, {"mime": "image/png",
                                                             "w": max_width})
            except Exception:
                return None
        if not data_url or not isinstance(data_url, str) or "," not in data_url:
            return None
        try:
            return base64.b64decode(data_url.split(",", 1)[1])
        except Exception:
            return None

    def ensure_rawcam_loop(self):
        """Фоновый захват сырых кадров — работает даже когда ИИшка на паузе/не запущена."""
        if getattr(self, "_rawcam_thread", None):
            return
        st = self.state

        def loop():
            while True:
                try:
                    if st.rawcam_on and self.page_ready():
                        self.grab_raw_frame()
                except Exception:
                    pass
                time.sleep(0.06)

        t = threading.Thread(target=loop, daemon=True)
        t.start()
        self._rawcam_thread = t

    def stop_all(self):
        with self.lock:
            if self.page is not None:
                try:
                    self.page.evaluate(
                        "() => { try { doomApi.stopMovement(); doomApi.stop(); } catch (e) {} }")
                except Exception:
                    pass

    def close(self):
        with self.lock:
            try:
                if self.browser:
                    self.browser.close()
                if self.playwright:
                    self.playwright.stop()
            except Exception:
                pass
            self.browser = None
            self.page = None
            self.playwright = None


# ----------------------------------------------------------------------------- AI agent thread

class Agent(threading.Thread):
    def __init__(self, state):
        super().__init__(daemon=True)
        self.state = state
        self.stop_event = threading.Event()
        self.paused = threading.Event()
        self.mode = "ai"            # 'ai' | 'manual' | 'idle'
        self.manual = {"mx": 0.0, "my": 0.0, "yaw": 0.0, "keys": [], "ts": 0.0}
        self.stats = {
            "status": "idle", "episode": 0, "generation": 0,
            "steps": 0, "fitness": None, "bestEver": None,
            "lastAction": None, "note": "", "startedAt": None,
            "reward": 0.0, "aliveSteps": 0, "killsSeen": 0, "pickupsSeen": 0,
        }
        self.action_log = deque(maxlen=120)
        self.episode_fitnesses = []
        self.chat = []             # история чата с ИИшкой
        self.rawcam_on = False     # включать ли захват сырого кадра для :8125
        self.pop = Population(FEATURE_COUNT, size=int(os.environ.get("AI_POP", "12")))
        self.stats["generation"] = self.pop.generation
        self._lock = threading.Lock()

    # ---- control

    def control(self, cmd):
        if cmd == "pause":
            self.paused.set()
        elif cmd == "resume":
            self.paused.clear()
        elif cmd == "stop":
            self.stop_event.set()
        elif cmd == "save":
            return save_population(self.pop)
        elif cmd == "reset":
            with self._lock:
                self.pop = Population(FEATURE_COUNT, size=len(self.pop.brains))
            self.episode_fitnesses = []
            self.stats["generation"] = 0
            return {"ok": True}
        return {"ok": True, "cmd": cmd, "paused": self.paused.is_set(),
                "stopping": self.stop_event.is_set()}

    def set_mode(self, mode):
        if mode in ("ai", "manual", "idle"):
            self.mode = mode
            if mode != "manual":
                self.manual = {"mx": 0.0, "my": 0.0, "yaw": 0.0, "keys": [], "ts": time.time()}
            self.state.log("режим: %s" % mode)
        return {"ok": True, "mode": self.mode}

    def feed_manual(self, mx, my, yaw, keys):
        self.manual = {"mx": clamp(mx), "my": clamp(my), "yaw": float(yaw),
                       "keys": keys, "ts": time.time()}

    # ---- chat with the AI

    def chat_send(self, text):
        text = (text or "").strip()[:1200]
        reply = self._reply(text)
        with self._lock:
            self.chat.append({"who": "user", "text": text, "at": now_iso()})
            self.chat.append({"who": "ai", "text": reply, "at": now_iso()})
            self.chat = self.chat[-100:]
        return {"ok": True, "reply": reply}

    def _reply(self, text):
        """Простая говорящая ИИшка: знает про своё состояние и умеет команды."""
        t = text.lower()
        st = self.state
        tr = st.agent
        cfg = st.cfg
        s = self.stats
        view = st.browser.view_data or {}
        p = view.get("player", {})
        # команды прямо в чате
        cmdmap = {"стоп": ("stop", "Останавливаюсь."), "стоп!": ("stop", "Останавливаюсь."),
                  "пауза": ("pause", "Пауза."), "продолжай": ("resume", "Продолжаю."),
                  "спаси": ("save", "Сохраняю мозги."), "сохрани": ("save", "Сохраняю мозги."),
                  "сброс": ("reset", "Сбрасываю популяцию. Больно, но полезно.")}
        for k, (c, msg) in cmdmap.items():
            if t.startswith(k):
                self.control(c)
                return msg
        if t.startswith("режим"):
            m = "ai" if ("нейро" in t or "ии" in t or "ai" in t) else \
                ("manual" if ("рук" in t or "manual" in t) else "idle")
            self.set_mode(m)
            return "Переключаюсь в режим %s." % m
        if any(w in t for w in ("привет", "здоров", "ку ", "хай")):
            return "Ку. Я тут DOOM долблю, поколение %d, лучший фитнес %s. Здоровье моё: %s." % (
                s["generation"], s["bestEver"], p.get("health", "?"))
        if "поколени" in t or "ген" in t or "прогресс" in t or "как дела" in t:
            return ("Поколение %d, эпизод %d, шагов %d. Последний фитнес %.2f, лучший %.2f. "
                    "Средний %.2f.") % (s["generation"], s["episode"], s["steps"],
                                        (s["fitness"] or 0.0),
                                        (s["bestEver"] or 0.0),
                                        (self.pop.history[-1]["avg"] if self.pop.history else 0.0))
        if "уровен" in t or "карт" in t or "мап" in t:
            return "Сейчас на %s (%s), позиция x=%.0f y=%.0f." % (
                view.get("levelCode", "?"), cfg["game"]["wadName"],
                float(p.get("x", 0)), float(p.get("y", 0)))
        if "зачем" in t or "что ты" in t or "умеешь" in t or "помощь" in t or "help" in t:
            return ("Я нейросетевой агент: смотрю getView(), выбираю действие из %d, "
                    "мозги эволюционируют по фитнесу. Умею: стоп / пауза / продолжай / "
                    "сохрани / сброс / режим ai|manual. Спрашивай про прогресс, уровень, врагов.")
        if "враг" in t or "монстр" in t:
            things = view.get("things", []) or []
            en = nearest_by_kind(things, ENEMY_HINTS, float(p.get("x", 0)), float(p.get("y", 0)),
                                 float(p.get("yaw", 0)))
            return ("Вижу ближайшего врага на дистанции %.0f (%s)." % (en[2], en[3])
                    if en else "Врагов рядом не вижу.")
        return ("Не понял, но я занят: поколение %d, шаг %d, последняя награда %.2f. "
                "Напиши «помощь» — расскажу что умею.") % (s["generation"], s["steps"], s["reward"])

    # ---- episode loop

    def run_episode(self, br, cfg, brain):
        steps = int(cfg["agent"]["stepsPerEpisode"])
        dt = float(cfg["agent"]["stepDelay"])
        rw = cfg["reward"]
        stats = [(0.0, 1.0) for _ in range(FEATURE_COUNT)]
        total = 0.0
        prev_raw = None
        alive = 0
        pickups_seen = 0
        hurt_seen = 0.0
        for step in range(steps):
            if self.stop_event.is_set():
                break
            while self.paused.is_set() and not self.stop_event.is_set():
                time.sleep(0.1)
            if self.stop_event.is_set():
                break
            view = br.snapshot()
            if view is None:
                time.sleep(dt)
                continue
            raw, feats = build_observation(view, stats)
            if self.mode == "manual":
                m = self.manual
                fresh = (time.time() - m["ts"]) < 1.0
                if fresh:
                    br.drive_manual(m["mx"], m["my"], m["yaw"], m["keys"])
                    br.mark_targets([])
                else:
                    br.drive_manual(0, 0, 0, [])
                action_name = "manual"
                yaw_used = 0.0
            elif self.mode == "idle":
                br.drive_manual(0, 0, 0, [])
                action_name = "idle"
                yaw_used = 0.0
            else:
                action, yaw, _probs = brain.act(np.array(feats), explore=True,
                                                temperature=float(cfg["agent"]["temperature"]))
                br.set_action(action, yaw)
                action_name = ACTIONS[action]
                yaw_used = yaw
                # отметки целей на трансляции
                marks = []
                for cand, kind_flag in ((raw.get("enemy"), "enemy"), (raw.get("item"), "item")):
                    if cand is None:
                        continue
                    scr = None
                    for th in (view.get("things") or []):
                        if abs(float(th.get("x", 1e18)) - (raw["x"] + cand[0])) < 1 and \
                           abs(float(th.get("y", 1e18)) - (raw["y"] + cand[1])) < 1:
                            scr = th.get("screen")
                            break
                    marks.append({"kind": cand[3], "sx": (scr or {}).get("x", -1),
                                  "sy": (scr or {}).get("y", -1),
                                  "depth": (scr or {}).get("depth", 0),
                                  "enemy": kind_flag == "enemy"})
                br.mark_targets(marks)
            self.stats["steps"] = step + 1
            self.stats["lastAction"] = {"idx": ACTIONS.index(action_name) if action_name in ACTIONS else -1,
                                       "name": action_name, "yaw": round(yaw_used, 1),
                                       "at": now_iso()}
            self.action_log.appendleft("%s · %s · hp=%s" % (
                self.stats["lastAction"]["at"], action_name, int(raw["health"])))
            br.grab_frame()
            if self.rawcam_on:
                br.grab_raw_frame()

            reward = float(rw.get("time", -0.01))
            if prev_raw is not None:
                moved = math.hypot(raw["x"] - prev_raw["x"], raw["y"] - prev_raw["y"])
                reward += float(rw.get("move", 0.05)) * min(moved, 60.0) / 60.0
                if moved < 0.3:
                    reward += float(rw.get("stuck", -0.03))
            if raw["health"] < (prev_raw or {}).get("health", raw["health"]):
                dh = (prev_raw or {}).get("health", raw["health"]) - raw["health"]
                reward += float(rw.get("hurt", -0.2)) * dh
                hurt_seen += dh
            if not raw["dead"]:
                reward += float(rw.get("survive", 0.05))
                alive += 1
                if raw.get("item") and raw["item"][2] < 60:
                    pickups_seen += 1
                    reward += float(rw.get("near_item", 0.02))
                if raw.get("enemy") and raw["enemy"][2] < 300:
                    reward += float(rw.get("near_enemy", 0.01))
            else:
                reward += float(rw.get("death", -20.0))
                total += reward
                self.stats["reward"] = round(total, 2)
                break
            total += reward
            self.stats["reward"] = round(total, 2)
            prev_raw = raw
            time.sleep(dt)
        self.stats["aliveSteps"] = alive
        self.stats["pickupsSeen"] = pickups_seen
        return total

    def launch_opts(self, cfg):
        g = cfg["game"]
        if g.get("wadUrl"):
            return {"url": g["wadUrl"], "levelCode": g["levelCode"],
                    "skill": g["skill"], "maxSpeed": g["maxSpeed"]}
        return {"wadId": g.get("wadName") or "freedoom1", "levelCode": g["levelCode"],
                "skill": g["skill"], "maxSpeed": g["maxSpeed"]}

    def run(self):
        self.stats["status"] = "running"
        self.stats["startedAt"] = now_iso()
        cfg = self.state.cfg
        br = self.state.browser
        if not br.available():
            self.stats["status"] = "error"
            self.stats["note"] = "нет playwright"
            return
        try:
            self.state.log("открываю сайт: %s" % cfg["siteUrl"])
            br.open_site(cfg["siteUrl"], headless=cfg.get("headless", True))
        except Exception as e:
            self.stats["status"] = "error"
            self.stats["note"] = "браузер: %s" % e
            self.state.log("браузер не поднялся: %s" % e)
            return

        ep_fit = []
        ep_brains = []
        while not self.stop_event.is_set():
            cfg = self.state.cfg
            if self.paused.is_set():
                time.sleep(0.2)
                continue
            brain = self.pop.pick_next() if self.mode == "ai" else self.pop.brains[0]
            try:
                res = br.launch_game(self.launch_opts(cfg))
                if isinstance(res, dict) and res.get("launchErr"):
                    self.state.log("launch: %s" % res["launchErr"])
            except Exception as e:
                self.state.log("launch_game: %s" % e)
                time.sleep(2.0)
                continue
            time.sleep(1.0)
            self.stats["episode"] += 1
            fit = self.run_episode(br, cfg, brain)
            self.stats["fitness"] = round(fit, 2)
            self.state.log("эпизод #%d: fitness %.2f (мозг %d/%d, режим %s)" % (
                self.stats["episode"], fit, self.pop.current_idx + 1, len(self.pop.brains), self.mode))
            if self.mode == "ai":
                ep_fit.append(fit)
                ep_brains.append(self.pop.current_idx)
                if len(ep_fit) >= len(self.pop.brains):
                    # разложить фитнесы по мозгам и эволюционировать
                    fits = [0.0] * len(self.pop.brains)
                    cnt = [0] * len(self.pop.brains)
                    for f, i in zip(ep_fit, ep_brains):
                        fits[i] += f
                        cnt[i] += 1
                    fits = [f / c if c else 0.0 for f, c in zip(fits, cnt)]
                    best = self.pop.update(fits)
                    self.stats["generation"] = self.pop.generation
                    if self.pop.best_ever:
                        self.stats["bestEver"] = round(self.pop.best_ever["fit"], 2)
                    self.state.log("=== поколение %d: best %.2f ===" % (self.pop.generation, best))
                    if cfg["agent"].get("autoSave", True):
                        save_population(self.pop)
                    ep_fit = []
                    ep_brains = []
            try:
                br.stop_all()
            except Exception:
                pass
        self.stats["status"] = "stopped"
        try:
            br.stop_all()
        except Exception:
            pass


# ----------------------------------------------------------------------------- app state

class AppState:
    def __init__(self):
        self.logs = deque(maxlen=600)
        self.game_server = GameServer(self)
        self.browser = Browser(self)
        self.agent = None
        self.cfg = {
            "siteUrl": "http://%s:%d/index.html" % (GAME_HOST, GAME_PORT),
            "headless": True,
            "game": {"wadName": "freedoom1", "wadUrl": None, "levelCode": "E1M1",
                     "skill": 3, "maxSpeed": True},
            "agent": {"stepsPerEpisode": 500, "stepDelay": 0.05, "temperature": 1.0,
                      "autoSave": True, "popSize": 12},
            "reward": {"move": 0.05, "stuck": -0.03, "hurt": -0.2, "death": -20.0,
                       "survive": 0.05, "time": -0.01, "near_item": 0.02, "near_enemy": 0.01},
            # порты: панель/трансляция, игровой сайт, сырая камера DOOMa (без UI)
            "ports": {"panel": STREAM_PORT, "game": GAME_PORT, "raw": RAW_PORT},
        }
        self._load_cfg()

    def _load_cfg(self):
        try:
            with open(os.path.join(STATE_DIR, "cfg.json"), "r", encoding="utf-8") as f:
                saved = json.load(f)
            for k, v in saved.items():
                if isinstance(v, dict) and isinstance(self.cfg.get(k), dict):
                    self.cfg[k].update(v)
                else:
                    self.cfg[k] = v
        except Exception:
            pass

    def save_cfg(self):
        try:
            os.makedirs(STATE_DIR, exist_ok=True)
            with open(os.path.join(STATE_DIR, "cfg.json"), "w", encoding="utf-8") as f:
                json.dump(self.cfg, f, indent=2, ensure_ascii=False)
        except Exception:
            pass

    def log(self, msg):
        line = "[%s] %s" % (now_iso(), msg)
        self.logs.append(line)
        print(line, flush=True)


STATE = AppState()


# ----------------------------------------------------------------------------- raw camera server (:8125)

RAW_PAGE_HTML = r"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>DOOM · сырая камера :8125</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:#000;color:#9ab;display:flex;
             align-items:center;justify-content:center;font-family:ui-monospace,monospace}
  img{max-width:100vw;max-height:100vh;image-rendering:pixelated;width:100%;object-fit:contain}
  #msg{position:fixed;top:8px;left:12px;font-size:12px;opacity:.75}
  a{color:#39c2cf;text-decoration:none}
</style></head>
<body>
  <div id="msg">кадра нет — ждём игру… (<a href="/raw.jpg">/raw.jpg</a> · <a href="/raw.mjpg">/raw.mjpg</a>)</div>
  <img id="cam" alt="">
<script>
const img=document.getElementById('cam'), msg=document.getElementById('msg');
let last=0, alive=false;
async function loop(){
  try{
    const r=await fetch('/api/rawinfo?ts='+Date.now());
    const j=await r.json();
    if(j.ts && j.ts!==last){ last=j.ts; img.src='/raw.jpg?t='+j.ts; }
    alive = !!j.ts && (Date.now()/1000 - j.ts) < 10;
    msg.textContent = alive ? ('raw '+(j.width||'?')+'x'+(j.height||'?')+' · '+(j.fps||'—')+' fps')
                             : 'кадра нет — ждём игру…';
  }catch(e){ msg.textContent='сервер недоступен'; }
  setTimeout(loop, 120);
}
loop();
</script>
</body></html>
"""


class RawHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state = None

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):
        st = self.state
        br = st.browser
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            self._send(200, "text/html; charset=utf-8", RAW_PAGE_HTML.encode("utf-8"))
        elif path == "/raw.jpg":
            jpeg = br.raw_jpeg or br.frame_jpeg
            if jpeg:
                self._send(200, "image/jpeg", jpeg)
            else:
                self._send(404, "text/plain; charset=utf-8", b"no frame yet")
        elif path == "/frame.png":
            png = None
            try:
                png = br.grab_png_frame()
            except Exception:
                png = None
            if png:
                self._send(200, "image/png", png)
            else:
                self._send(404, "text/plain; charset=utf-8", b"no frame yet")
        elif path == "/raw.mjpg":
            self.send_response(200)
            self.send_header("Content-Type",
                             "multipart/x-mixed-replace; boundary=rawframe")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            jet = Jet(b"--rawframe")
            last_ts = 0.0
            try:
                while True:
                    jpeg = br.raw_jpeg or br.frame_jpeg
                    ts = br.raw_ts or br.frame_ts
                    if jpeg and ts != last_ts:
                        self.wfile.write(jet.multipart(jpeg))
                        self.wfile.flush()
                        last_ts = ts
                    else:
                        time.sleep(0.05)
            except Exception:
                pass
        elif path == "/api/rawinfo":
            jpeg = br.raw_jpeg or br.frame_jpeg
            ts = (br.raw_ts if br.raw_jpeg else br.frame_ts) or 0.0
            w = h = 0
            if jpeg:
                i = 2
                try:
                    while i < len(jpeg) - 9:
                        if jpeg[i] != 0xFF:
                            i += 1
                            continue
                        m = jpeg[i + 1]
                        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
                            i += 2
                            continue
                        ln = int.from_bytes(jpeg[i + 2:i + 4], "big")
                        if m in (0xC0, 0xC1, 0xC2, 0xC3):
                            h = int.from_bytes(jpeg[i + 5:i + 7], "big")
                            w = int.from_bytes(jpeg[i + 7:i + 9], "big")
                            break
                        i += 2 + ln
                except Exception:
                    pass
            ag = st.agent
            fps = round(1.0 / max(0.001, float(st.cfg["agent"].get("stepDelay", 0.05))), 1)
            self._send(200, "application/json", json.dumps({
                "ok": True, "ts": ts, "width": w, "height": h, "bytes": len(jpeg or b""),
                "fps": fps, "agentRunning": bool(ag and ag.stats.get("status") == "running"),
            }).encode("utf-8"))
        else:
            self._send(404, "text/plain; charset=utf-8", b"not found")


def start_raw_server(port=None, host=None):
    """Сервер СЫРОЙ КАМЕРЫ игрока: картинка DOOMa без всякого UI панели."""
    global RAW_PORT, _raw_httpd
    p = int(port or STATE.cfg.get("ports", {}).get("raw") or RAW_PORT)
    h = host or RAW_HOST
    RawHandler.state = STATE
    if _raw_httpd is not None and RAW_PORT == p:
        STATE.rawcam_on = True
        STATE.browser.ensure_rawcam_loop()
        return _raw_httpd          # уже крутится на этом порту
    try:
        httpd = ThreadingHTTPServer((h, p), RawHandler)
    except OSError as e:
        STATE.log("сырая камера: порт %d занят (%s)" % (p, e))
        return None
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    if _raw_httpd is not None and _raw_httpd is not httpd:
        try:
            _raw_httpd.shutdown()
            _raw_httpd.server_close()
        except Exception:
            pass
    _raw_httpd = httpd
    RAW_PORT = p
    STATE.cfg.setdefault("ports", {})["raw"] = p
    STATE.save_cfg()
    STATE.rawcam_on = True   # агент начинает захватывать сырые кадры для этого порта
    STATE.browser.ensure_rawcam_loop()   # фоновый захват (не зависит от ИИшки)
    STATE.log("СЫРАЯ КАМЕРА DOOMa: http://localhost:%d/raw.mjpg "
              "(статичный кадр: /raw.jpg, PNG: /frame.png)" % p)
    return httpd


def stop_raw_server():
    global _raw_httpd
    STATE.rawcam_on = False
    if _raw_httpd is not None:
        try:
            _raw_httpd.shutdown()
            _raw_httpd.server_close()
        except Exception:
            pass
        _raw_httpd = None
        STATE.log("сырая камера остановлена")
    return {"ok": True}


# ----------------------------------------------------------------------------- multipart stream

class Jet:
    def __init__(self, boundary=b"--frameboundary"):
        self.boundary = boundary

    def multipart(self, bytes_jpg):
        return (b"".join([self.boundary, b"\r\nContent-Type: image/jpeg\r\n\r\n",
                          bytes_jpg, b"\r\n"]))


# ----------------------------------------------------------------------------- HTTP handler (:8090)

class StreamHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state = None

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, ctype, body, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _json(self, obj, code=200):
        self._send(code, "application/json; charset=utf-8",
                   json.dumps(obj, default=str, ensure_ascii=False).encode("utf-8"))

    def _query(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    # ---- GET

    def do_GET(self):
        st = self.state
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            self._send(200, "text/html; charset=utf-8", PAGE_HTML.encode("utf-8"))
        elif path == "/stream.mjpg":
            self.send_response(200)
            self.send_header("Content-Type",
                             "multipart/x-mixed-replace; boundary=frameboundary")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            jet = Jet()
            last_ts = 0.0
            try:
                while True:
                    jpeg = st.browser.frame_jpeg
                    ts = st.browser.frame_ts
                    if jpeg and ts != last_ts:
                        self.wfile.write(jet.multipart(jpeg))
                        self.wfile.flush()
                        last_ts = ts
                    else:
                        time.sleep(0.03)
            except Exception:
                pass
        elif path == "/frame.jpg":
            jpeg = st.browser.frame_jpeg
            if jpeg:
                self._send(200, "image/jpeg", jpeg)
            else:
                self._json({"error": "кадра пока нет"}, 404)
        elif path == "/api/state":
            ag = st.agent
            view = st.browser.view_data or {}
            pop = ag.pop if ag else None
            self._json({
                "server": {"streamPort": STREAM_PORT, "gamePort": st.game_server.port,
                           "gameUrl": "http://%s:%d/" % (GAME_HOST, st.game_server.port),
                           "rawPort": RAW_PORT, "rawUrl": "http://localhost:%d/" % RAW_PORT,
                           "rawMjpg": "http://localhost:%d/raw.mjpg" % RAW_PORT,
                           "browserReady": st.browser.available()},
                "config": st.cfg,
                "agent": (dict(ag.stats) if ag else {"status": "idle"}),
                "mode": ag.mode if ag else "ai",
                "paused": bool(ag.paused.is_set()) if ag else False,
                "logs": list(st.logs)[-60:],
                "actionLog": list(ag.action_log) if ag else [],
                "chat": ag.chat if ag else [],
                "view": view,
                "brain": ({
                    "generation": pop.generation,
                    "size": len(pop.brains),
                    "current": pop.current_idx,
                    "history": pop.history[-80:],
                    "bestEver": pop.best_ever["fit"] if pop.best_ever else None,
                    "nodes": [pop.brains[0].n_in, pop.brains[0].n_hidden, pop.brains[0].n_actions],
                } if pop else None),
                "frameTs": st.browser.frame_ts,
            })
        elif path == "/api/wads":
            self._json({"wads": scan_wads()})
        elif path == "/api/window":
            br = st.browser
            with br.lock:
                page = br.page
            data = None
            if page is not None:
                try:
                    data = page.evaluate("""() => {
                        const out = {};
                        for (const k of Object.keys(window)) {
                          try {
                            const v = window[k];
                            const t = typeof v;
                            if (t === 'string' || t === 'number' || t === 'boolean' || v === null) out[k] = v;
                            else if (t === 'object' && !(v instanceof Node) && !(v instanceof Window)) {
                              const s = JSON.stringify(v);
                              if (s && s.length < 4000) out[k] = JSON.parse(s);
                            } else if (t === 'function') out[k] = '[fn ' + v.name + ']';
                          } catch (e) {}
                        }
                        return out; }""")
                except Exception as e:
                    data = {"error": str(e)}
            self._json({"window": data})
        else:
            self._json({"error": "not found"}, 404)

    # ---- POST

    def do_POST(self):
        st = self.state
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            body = {}

        if path == "/api/config":
            for k, v in body.items():
                if isinstance(v, dict) and isinstance(st.cfg.get(k), dict):
                    st.cfg[k].update(v)
                else:
                    st.cfg[k] = v
            st.save_cfg()
            self._json({"ok": True, "config": st.cfg})
        elif path == "/api/game-server/start":
            self._json(st.game_server.start(body.get("port")))
        elif path == "/api/game-server/stop":
            self._json(st.game_server.stop())
        elif path == "/api/rawcam/start":
            httpd = start_raw_server(body.get("port"))
            self._json({"ok": httpd is not None, "rawPort": RAW_PORT})
        elif path == "/api/rawcam/stop":
            self._json(stop_raw_server())
        elif path == "/api/agent/start":
            if st.agent is not None and st.agent.is_alive():
                self._json({"ok": False, "error": "агент уже запущен"})
                return
            st.agent = Agent(st)
            if body.get("loadBrains", True):
                loaded = load_population(FEATURE_COUNT)
                if loaded is not None:
                    st.agent.pop = loaded
                    st.agent.stats["generation"] = loaded.generation
                    if loaded.best_ever:
                        st.agent.stats["bestEver"] = round(loaded.best_ever["fit"], 2)
                    st.log("загружены мозги: поколение %d" % loaded.generation)
            st.agent.start()
            self._json({"ok": True})
        elif path == "/api/agent/stop":
            if st.agent:
                st.agent.control("stop")
            self._json({"ok": True})
        elif path.startswith("/api/agent/"):
            cmd = path.rsplit("/", 1)[-1]
            if st.agent is None:
                self._json({"ok": False, "error": "агент не запущен"}, 409)
                return
            self._json(st.agent.control(cmd))
        elif path == "/api/mode":
            if st.agent is None:
                self._json({"ok": False, "error": "агент не запущен"}, 409)
                return
            self._json(st.agent.set_mode(str(body.get("mode", "ai"))))
        elif path == "/api/manual":
            if st.agent is None:
                self._json({"ok": False, "error": "агент не запущен"}, 409)
                return
            st.agent.feed_manual(float(body.get("mx", 0)), float(body.get("my", 0)),
                                 float(body.get("yaw", 0)), list(body.get("keys", [])))
            self._json({"ok": True})
        elif path == "/api/chat":
            if st.agent is None:
                self._json({"ok": False, "error": "агент не запущен"}, 409)
                return
            self._json(st.agent.chat_send(str(body.get("text", ""))))
        elif path == "/api/stream/toggle":
            st.browser.stream_enabled = not st.browser.stream_enabled
            self._json({"ok": True, "enabled": st.browser.stream_enabled})
        elif path == "/api/wads/download":
            fname = str(body.get("fileName", ""))
            urls = [u for name, us in DOWNLOADS if name == fname for u in us]
            if not urls:
                self._json({"ok": False, "error": "неизвестный файл"}, 400)
                return
            self._json(download_wad(fname, urls, os.path.join(SITE_DIR, "wads")))
        else:
            self._json({"error": "not found"}, 404)


# ----------------------------------------------------------------------------- panel html

PAGE_HTML = r"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DOOM · ИИшка + трансляция + панель (:8090)</title>
<style>
:root{--bg:#0b0e14;--card:#141a23;--line:#2a3342;--fg:#dbe4ef;--dim:#7d8ba0;--acc:#ff6a1f;--ok:#3fb950;--bad:#f85149;--cy:#39c2cf}
*{box-sizing:border-box}body{margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--bg);color:var(--fg)}
header{padding:12px 18px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:#0d1219}
header h1{font-size:15px;margin:0;color:var(--acc)}
.badge{font-size:11px;padding:3px 9px;border:1px solid var(--line);border-radius:20px;color:var(--dim)}
.badge.on{color:var(--ok);border-color:var(--ok)}
main{display:grid;grid-template-columns:minmax(420px,2fr) minmax(340px,1fr);gap:14px;padding:14px}
@media(max-width:1000px){main{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:14px}
.card h2{margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}
video,.framebox{width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;display:block;object-fit:contain}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button{background:#1d2634;color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:7px 12px;font:inherit;cursor:pointer}
button:hover{border-color:var(--acc)}button.acc{background:var(--acc);color:#111;border-color:var(--acc);font-weight:700}
button.small{padding:4px 8px;font-size:11px}
label{font-size:11px;color:var(--dim);display:block;margin-bottom:2px}
input,select{background:#0d1420;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:5px 7px;font:inherit;width:100%}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.kv{display:flex;justify-content:space-between;font-size:12px;padding:2px 0;border-bottom:1px dashed #1d2634}
.kv span:first-child{color:var(--dim)}
pre.log{height:180px;overflow:auto;background:#0a0f16;border:1px solid var(--line);border-radius:6px;padding:8px;font-size:11px;margin:0;white-space:pre-wrap}
#chatlog{height:170px;overflow:auto;font-size:12px;background:#0a0f16;border:1px solid var(--line);border-radius:6px;padding:8px;margin-bottom:8px}
.msg{margin:2px 0}.msg.user{color:var(--cy)}.msg.ai{color:var(--ok)}
canvas.mini{width:100%;height:150px;background:#0a0f16;border:1px solid var(--line);border-radius:6px}
.pad{display:grid;grid-template-columns:repeat(3,44px);grid-template-rows:repeat(3,44px);gap:4px}
.pad button{padding:0;font-size:16px}
.tag{font-size:10px;border:1px solid var(--line);border-radius:4px;padding:1px 6px;color:var(--dim)}
.gauge{height:8px;border-radius:4px;background:#0a0f16;overflow:hidden;margin-top:2px}
.gauge i{display:block;height:100%;background:var(--ok)}
footer{padding:8px 18px;color:var(--dim);font-size:11px;border-top:1px solid var(--line)}
a{color:var(--cy)}
input[type=checkbox]{accent-color:var(--acc)}
</style>
</head>
<body>
<header>
  <h1>☠ DOOM · ИИШКА + ТРАНСЛЯЦИЯ</h1>
  <span class="badge" id="b-game">игра: —</span>
  <span class="badge" id="b-agent">агент: —</span>
  <span class="badge" id="b-mode">режим: ai</span>
  <span class="badge" id="b-gen">gen 0</span>
  <span class="badge" id="b-fit">best —</span>
  <div style="flex:1"></div>
  <a href="#" onclick="window.open('/api/window','_blank');return false" class="tag">window API</a>
</header>
<main>
<section>
  <div class="card">
    <h2>Трансляция (стрим с :8090 через window.doomApi)</h2>
    <img id="stream" class="framebox" src="/frame.jpg" alt="нет кадра">
    <div class="row" style="margin-top:8px">
      <button id="btn-stream" class="small">⏸ заморозить стрим</button>
      <button class="small" onclick="document.getElementById('stream').src='/frame.jpg?t='+Date.now()">обновить кадр</button>
      <span class="tag" id="fps">—</span>
      <label class="tag" style="display:flex;gap:6px;align-items:center;width:auto;margin-left:auto">
        <input type="checkbox" id="rawcam" checked style="width:auto"> сырая камера DOOMa:
      </label>
      <input id="raw-port-in" type="number" value="8125" style="width:70px;padding:2px 4px;background:#0a0f16;color:#cfe;border:1px solid #234;border-radius:4px">
      <button class="small" id="btn-rawapply">⇄ порт</button>
      <a class="tag" id="raw-link" href="http://localhost:8125/raw.mjpg" target="_blank">🎥 /raw.mjpg</a>
      <a class="tag" id="raw-jpg" href="http://localhost:8125/raw.jpg" target="_blank">/raw.jpg</a>
    </div>
  </div>

  <div class="card">
    <h2>HUD агента</h2>
    <div class="grid2">
      <div><label>Здоровье</label><div class="gauge"><i id="hp-bar" style="width:100%"></i></div><div class="kv"><span>HP</span><b id="hud-hp">—</b></div></div>
      <div><label>Броня</label><div class="gauge"><i id="ar-bar" style="width:0%;background:var(--cy)"></i></div><div class="kv"><span>ARMOR</span><b id="hud-ar">—</b></div></div>
      <div class="kv"><span>уровень</span><b id="hud-level">—</b></div>
      <div class="kv"><span>позиция</span><b id="hud-pos">—</b></div>
      <div class="kv"><span>yaw</span><b id="hud-yaw">—</b></div>
      <div class="kv"><span>оружие / патроны</span><b id="hud-wp">—</b></div>
      <div class="kv"><span>последнее действие</span><b id="hud-act">—</b></div>
      <div class="kv"><span>шаг эпизода</span><b id="hud-step">—</b></div>
    </div>
    <canvas class="mini" id="minimap" width="600" height="150"></canvas>
  </div>

  <div class="card">
    <h2>Чат с ИИшкой</h2>
    <div id="chatlog"></div>
    <div class="row">
      <input id="chat-in" placeholder="спроси что-нибудь или напиши «помощь»…" style="flex:1">
      <button class="acc" onclick="sendChat()">➤</button>
    </div>
    <div class="row" style="margin-top:6px">
      <button class="small" onclick="quick('как дела?')">как дела?</button>
      <button class="small" onclick="quick('прогресс')">прогресс</button>
      <button class="small" onclick="quick('где враги?')">где враги?</button>
      <button class="small" onclick="quick('помощь')">помощь</button>
      <button class="small" onclick="quick('пауза')">⏸ пауза</button>
      <button class="small" onclick="quick('продолжай')">▶ продолжить</button>
    </div>
  </div>
</section>

<section>
  <div class="card">
    <h2>Управление</h2>
    <div class="row">
      <button class="acc" onclick="post('/api/agent/start',{loadBrains:true})">🧠 ЗАПУСТИТЬ ИИ</button>
      <button onclick="post('/api/agent/pause')">⏸</button>
      <button onclick="post('/api/agent/resume')">▶</button>
      <button onclick="post('/api/agent/stop')">⏹ стоп</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button onclick="post('/api/agent/save')">💾 сохранить мозги</button>
      <button onclick="if(confirm('Сбросить популяцию?'))post('/api/agent/reset')">♻ сброс</button>
      <button id="b-game-server" onclick="toggleGameServer()">🌐 игровой сервер</button>
    </div>
    <div class="row" style="margin-top:10px">
      <label style="width:auto">режим:</label>
      <button class="small" id="m-ai" onclick="setMode('ai')">🤖 ИИ</button>
      <button class="small" id="m-manual" onclick="setMode('manual')">🎮 руки</button>
      <button class="small" id="m-idle" onclick="setMode('idle')">🚶 смотреть</button>
    </div>
    <div class="pad" style="margin-top:10px" id="pad">
      <span></span><button data-k="w">↑</button><span></span>
      <button data-k="a">←</button><button data-k="s">↓</button><button data-k="d">→</button>
      <button data-k="q">⟲</button><button data-k="f">🔫</button><button data-k="e">✋</button>
    </div>
    <div class="kv"><span>эпизодов / поколений</span><b id="c-ep">—</b></div>
    <div class="kv"><span>фитнес текущего</span><b id="c-fit">—</b></div>
    <div class="kv"><span>лучший когда-либо</span><b id="c-best">—</b></div>
  </div>

  <div class="card">
    <h2>Игра / WAD</h2>
    <div class="grid2">
      <div><label>WAD</label><select id="g-wad"></select></div>
      <div><label>уровень</label><input id="g-level" value="E1M1"></div>
      <div><label>skill 0–4</label><input type="number" id="g-skill" min="0" max="4" value="3"></div>
      <div><label>URL своего wad (или пусто)</label><input id="g-url" placeholder="https://…/custom.wad"></div>
    </div>
    <div class="row" style="margin-top:8px">
      <label style="display:flex;gap:6px;align-items:center;width:auto">
        <input type="checkbox" id="g-speed" checked style="width:auto"> maxSpeed</label>
      <button class="small" onclick="applyGame()">применить</button>
      <button class="small" id="dl-f1" onclick="dl('freedoom1.wad')">↓ freedoom1</button>
      <button class="small" id="dl-f2" onclick="dl('freedoom2.wad')">↓ freedoom2</button>
    </div>
  </div>

  <div class="card">
    <h2>Мозг / гиперпараметры</h2>
    <div class="grid2">
      <div><label>шагов на эпизод</label><input type="number" id="a-steps" value="500"></div>
      <div><label>задержка шага, с</label><input type="number" id="a-dt" step="0.01" value="0.05"></div>
      <div><label>температура</label><input type="number" id="a-temp" step="0.1" value="1"></div>
      <div><label>размер популяции*</label><input type="number" id="a-pop" value="12"></div>
    </div>
    <div class="row" style="margin-top:8px">
      <label style="display:flex;gap:6px;align-items:center;width:auto">
        <input type="checkbox" id="a-save" checked style="width:auto"> автосейв мозга</label>
      <button class="small" onclick="applyAgent()">применить</button>
      <span class="tag">* применится после сброса</span>
    </div>
    <canvas class="mini" id="fitgraph" width="600" height="150"></canvas>
  </div>

  <div class="card">
    <h2>Логи</h2>
    <pre class="log" id="logs">—</pre>
  </div>
</section>
</main>
<footer>
  Панель+стрим: <b>:8090</b> · игра раздаётся на <b id="f-game">:8123</b> ·
  сырая камера DOOMa: <b><a id="f-raw" href="http://localhost:8125/" target="_blank">:8125/raw.mjpg</a></b> ·
  всё через <b>window.doomApi</b> (launch/getView/setMove/screenshot/draw) в headless Chromium
</footer>
<script>
let STATE={}, CFG={}, KEYS={}, streamFrozen=false;

async function post(u,b){ try{ const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}); const j=await r.json(); flash(JSON.stringify(j).slice(0,120)); return j;}catch(e){flash('ERR '+e);} }
function flash(t){ const el=document.getElementById('hud-act'); el.textContent=t; }

// ---------- polling state
async function refresh(){
  try{
    const r=await fetch('/api/state'); STATE=await r.json(); CFG=STATE.config||CFG;
  }catch(e){ return; }
  const ag=STATE.agent||{}, v=STATE.view||{}, p=v.player||{}, br=STATE.brain;
  document.getElementById('b-game').textContent='игра: '+(STATE.server.gameUrl)+'';
  document.getElementById('b-game').className='badge'+(STATE.server?' on':'');
  document.getElementById('b-agent').textContent='агент: '+(ag.status||'—');
  document.getElementById('b-agent').className='badge'+(ag.status==='running'&&!STATE.paused?' on':'');
  document.getElementById('b-mode').textContent='режим: '+STATE.mode;
  document.getElementById('b-gen').textContent='gen '+(br?br.generation:0);
  document.getElementById('b-fit').textContent='best '+(br&&br.bestEver!=null?br.bestEver.toFixed(1):'—');
  document.getElementById('f-game').textContent=':'+STATE.server.gamePort;
  // сырая камера: порты и ссылки (берём хост, с которого открыта панель)
  const rp = STATE.server.rawPort || 8125;
  const rawBase = 'http://'+location.hostname+':'+rp;
  const rpi = document.getElementById('raw-port-in');
  if (rpi && document.activeElement !== rpi) rpi.value = rp;
  document.getElementById('raw-link').href = rawBase+'/raw.mjpg';
  document.getElementById('raw-jpg').href = rawBase+'/raw.jpg';
  document.getElementById('f-raw').textContent = ':'+rp+'/raw.mjpg';
  document.getElementById('f-raw').href = rawBase+'/';
  document.getElementById('hud-hp').textContent=(p.health!=null?p.health:'—');
  document.getElementById('hp-bar').style.width=Math.max(0,Math.min(100,(p.health||0)))+'%';
  document.getElementById('hud-ar').textContent=(p.armor!=null?p.armor:'—');
  document.getElementById('ar-bar').style.width=Math.max(0,Math.min(100,(p.armor||0)))+'%';
  document.getElementById('hud-level').textContent=v.levelCode||'—';
  document.getElementById('hud-pos').textContent=p.x!=null?(p.x.toFixed(0)+', '+p.y.toFixed(0)):'—';
  document.getElementById('hud-yaw').textContent=p.yaw!=null?p.yaw.toFixed(0)+'°':'—';
  const w=p.weapon, am=p.ammo;
  document.getElementById('hud-wp').textContent=(w?(w.name||w.code||JSON.stringify(w)):'—')+' / '+(am&&am.current!=null?am.current:'—');
  if(ag.lastAction) document.getElementById('hud-act').textContent=ag.lastAction.name+' (yaw '+ag.lastAction.yaw+')';
  document.getElementById('hud-step').textContent=ag.steps+' / эпизод #'+ag.episode;
  document.getElementById('c-ep').textContent=(ag.episode||0)+' / '+(ag.generation||0);
  document.getElementById('c-fit').textContent=ag.fitness!=null?ag.fitness:'—';
  document.getElementById('c-best').textContent=ag.bestEver!=null?ag.bestEver:'—';
  document.getElementById('logs').textContent=(STATE.logs||[]).join('\n');
  document.getElementById('logs').scrollTop=1e9;
  renderMinimap(v); renderGraph(br); renderChat();
}
setInterval(refresh,800);

// ---------- stream
setInterval(()=>{ if(!streamFrozen){ const im=document.getElementById('stream'); im.src='/frame.jpg?t='+Date.now(); } },120);
document.getElementById('btn-stream').onclick=()=>{ streamFrozen=!streamFrozen;
  document.getElementById('btn-stream').textContent=streamFrozen?'▶ разморозить':'⏸ заморозить стрим'; };

// ---------- minimap: things вокруг игрока
function renderMinimap(v){
  const c=document.getElementById('minimap'),x=c.getContext('2d');
  x.fillStyle='#0a0f16';x.fillRect(0,0,c.width,c.height);
  const p=(v&&v.player)||{}; if(p.x==null)return;
  const R=1200, cx=c.width/2, cy=c.height/2, s=Math.min(c.width,c.height)/(2*R);
  x.strokeStyle='#223';x.beginPath();x.arc(cx,cy,R*s,0,6.283);x.stroke();
  for(const t of (v.things||[])){
    const dx=(t.x-p.x)*s, dy=-(t.y-p.y)*s;
    if(Math.hypot(dx,dy)>R*s)continue;
    const k=(t.kind||'').toLowerCase();
    let col='#40a0ff';
    if(/monster|enemy|imp|demon|baron|knight|zombie|soldier/.test(k))col='#ff4040';
    else if(/item|pickup|health|armor|ammo|weapon/.test(k))col='#40ff80';
    x.fillStyle=col;x.fillRect(cx+dx-2,cy+dy-2,4,4);
  }
  // направление взгляда
  const yr=(p.yaw||0)*Math.PI/180;
  x.strokeStyle='#ff6a1f';x.beginPath();x.moveTo(cx,cy);x.lineTo(cx+Math.cos(yr)*14,cy-Math.sin(yr)*14);x.stroke();
  x.fillStyle='#fff';x.fillRect(cx-2,cy-2,4,4);
}

// ---------- fitness graph
function renderGraph(br){
  const c=document.getElementById('fitgraph'),x=c.getContext('2d');
  x.fillStyle='#0a0f16';x.fillRect(0,0,c.width,c.height);
  if(!br||!br.history||!br.history.length)return;
  const h=br.history, xs=h.map((_,i)=>i), ys=h.map(e=>e.best), avgs=h.map(e=>e.avg);
  const ymin=Math.min(...avgs,...ys,0), ymax=Math.max(...ys,1);
  const X=i=>10+i*(c.width-20)/Math.max(1,h.length-1);
  const Y=val=>c.height-10-(val-ymin)/(ymax-ymin+1e-9)*(c.height-20);
  x.strokeStyle='#39c2cf';x.beginPath();h.forEach((e,i)=>{i?x.lineTo(X(i),Y(e.avg)):x.moveTo(X(i),Y(e.avg))});x.stroke();
  x.strokeStyle='#ff6a1f';x.lineWidth=2;x.beginPath();h.forEach((e,i)=>{i?x.lineTo(X(i),Y(e.best)):x.moveTo(X(i),Y(e.best))});x.stroke();
  x.lineWidth=1;x.fillStyle='#7d8ba0';x.fillText('best / avg по поколениям ('+h.length+')',12,14);
}

// ---------- chat
function renderChat(){
  const el=document.getElementById('chatlog');
  const ch=STATE.chat||[];
  if(ch.length!==el.childElementCount){
    el.innerHTML=ch.map(m=>'<div class="msg '+m.who+'">'+(m.who==='user'?'🧑 ':'🤖 ')+esc(m.text)+'</div>').join('');
    el.scrollTop=1e9;
  }
}
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}
function sendChat(){
  const inp=document.getElementById('chat-in'); const t=inp.value.trim(); if(!t)return;
  inp.value=''; post('/api/chat',{text:t}).then(()=>{refresh();renderChat.call(null);});
}
document.getElementById('chat-in').addEventListener('keydown',e=>{if(e.key==='Enter')sendChat();});
function quick(t){document.getElementById('chat-in').value=t;sendChat();}

// ---------- controls
function setMode(m){ post('/api/mode',{mode:m}).then(refresh); }
function applyGame(){
  post('/api/config',{game:{wadName:document.getElementById('g-wad').value,
    levelCode:document.getElementById('g-level').value,
    skill:parseInt(document.getElementById('g-skill').value),
    maxSpeed:document.getElementById('g-speed').checked,
    wadUrl:document.getElementById('g-url').value||null}}).then(refresh);
}
function applyAgent(){
  post('/api/config',{agent:{stepsPerEpisode:parseInt(document.getElementById('a-steps').value),
    stepDelay:parseFloat(document.getElementById('a-dt').value),
    temperature:parseFloat(document.getElementById('a-temp').value),
    popSize:parseInt(document.getElementById('a-pop').value),
    autoSave:document.getElementById('a-save').checked}}).then(refresh);
}
async function toggleGameServer(){
  const running=document.getElementById('b-game-server').dataset.on==='1';
  await post(running?'/api/game-server/stop':'/api/game-server/start',{});
  refresh();
}
// ---------- сырая камера DOOMa (:8125 по умолчанию)
document.getElementById('rawcam').addEventListener('change', async e=>{
  if(e.target.checked){ const j=await post('/api/rawcam/start',{port:parseInt(document.getElementById('raw-port-in').value)||undefined}); flash(JSON.stringify(j)); }
  else { await post('/api/rawcam/stop',{}); flash('сырая камера остановлена'); }
  refresh();
});
document.getElementById('btn-rawapply').onclick = async ()=>{
  const p=parseInt(document.getElementById('raw-port-in').value);
  if(!p||p<1||p>65535){flash('некорректный порт');return;}
  const j=await post('/api/rawcam/start',{port:p});
  flash(j.ok?('сырая камера → :'+j.rawPort):('порт занят / ошибка'));
  refresh();
};
function dl(name){ const b=document.getElementById('dl-'+(name.includes('2')?'f2':'f1')); b.textContent='…качаю';
  post('/api/wads/download',{fileName:name}).then(j=>{b.textContent=j.ok?('✓ '+name):('✗ '+j.error); loadWads();}); }
async function loadWads(){
  try{ const r=await fetch('/api/wads'); const j=await r.json();
    const sel=document.getElementById('g-wad'); const cur=sel.value;
    sel.innerHTML=(j.wads||[]).map(w=>'<option value="'+w.name+'"'+(w.ok?'':' disabled')+
      '>'+w.name+(w.ok?'':' (нет — можно скачать)')+'</option>').join('');
    if(cur)sel.value=cur; if(CFG.game&&CFG.game.wadName)sel.value=CFG.game.wadName;
  }catch(e){}
}
setInterval(loadWads,15000); loadWads();

// ---------- manual pad + keyboard
const KEYMAP={w:['forward'],s:['back'],a:['strafeLeft'],d:['strafeRight'],
  arrowup:['forward'],arrowdown:['back'],arrowleft:['turnLeft'],arrowright:['turnRight'],
  q:['turnLeft'],e:['use'],f:['attack'],shift:['run']};
function sendManual(){
  const mx=(KEYMAP.d&&KEYS.d?1:0)-(KEYS.a?1:0);
  const my=(KEYS.w||KEYS.arrowup?1:0)-(KEYS.s||KEYS.arrowdown?1:0);
  const yaw=(KEYS.arrowright||KEYS.d&&false?1:0)-(KEYS.q||KEYS.arrowleft?1:0)
            +(KEYS.arrowright?1:0);
  const keys=[]; if(KEYS.shift)keys.push('run'); if(KEYS.e)keys.push('use'); if(KEYS.f)keys.push('attack');
  fetch('/api/manual',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({mx:mx,my:my,yaw:yaw*15,keys:keys})});
}
window.addEventListener('keydown',e=>{const k=e.key.toLowerCase();
  if(KEYMAP[k]){ if(document.getElementById('m-manual').classList.contains('on')||true){} KEYS[k]=true; sendManual(); e.preventDefault(); }});
window.addEventListener('keyup',e=>{KEYS[e.key.toLowerCase()]=false; sendManual();});
for(const b of document.querySelectorAll('#pad button[data-k]')){
  const k=b.dataset.k;
  b.addEventListener('pointerdown',()=>{KEYS[k]=true;sendManual();});
  b.addEventListener('pointerup',()=>{KEYS[k]=false;sendManual();});
  b.addEventListener('pointerleave',()=>{if(KEYS[k]){KEYS[k]=false;sendManual();}});
}
refresh();
</script>
</body>
</html>
"""


# ----------------------------------------------------------------------------- main

def main():
    global STREAM_PORT, GAME_PORT, RAW_PORT
    ap = argparse.ArgumentParser(description="DOOM AI stream + control panel")
    ap.add_argument("--port", type=int, default=None,
                    help="панель + трансляция (default 8090)")
    ap.add_argument("--game-port", type=int, default=None, help="сервер сайта игры (default 8123)")
    ap.add_argument("--raw-port", type=int, default=None,
                    help="СЫРАЯ КАМЕРА DOOMa без UI (default 8125)")
    ap.add_argument("--wad", default="freedoom1")
    ap.add_argument("--level", default="E1M1")
    ap.add_argument("--show", action="store_true", help="браузер с окном (не headless)")
    ap.add_argument("--no-agent", action="store_true", help="не стартовать ИИшку сразу")
    args = ap.parse_args()

    # порты: CLI > сохранённый cfg.json > дефолты (8090 панель / 8123 игра / 8125 сырая камера)
    saved_ports = STATE.cfg.get("ports", {})
    STREAM_PORT = args.port or saved_ports.get("panel") or STREAM_PORT
    GAME_PORT = args.game_port or saved_ports.get("game") or GAME_PORT
    RAW_PORT = args.raw_port or saved_ports.get("raw") or RAW_PORT
    STATE.cfg["ports"] = {"panel": STREAM_PORT, "game": GAME_PORT, "raw": RAW_PORT}
    STATE.cfg["siteUrl"] = "http://%s:%d/index.html" % (GAME_HOST, GAME_PORT)
    STATE.cfg["game"]["wadName"] = args.wad
    STATE.cfg["game"]["levelCode"] = args.level.upper()
    if args.show:
        STATE.cfg["headless"] = False
    STATE.save_cfg()

    print("=" * 62)
    print("Панель + трансляция:  http://localhost:%d" % STREAM_PORT)
    print("Игровой сайт:         http://localhost:%d" % GAME_PORT)
    print("Сырая камера DOOMa:   http://localhost:%d  (/raw.mjpg, /raw.jpg)" % RAW_PORT)
    print("=" * 62)

    # 1) панель/стрим на :8090
    StreamHandler.state = STATE
    try:
        httpd = ThreadingHTTPServer((STREAM_HOST, STREAM_PORT), StreamHandler)
    except OSError as e:
        print("Порт %d занят: %s" % (STREAM_PORT, e), flush=True)
        sys.exit(1)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    STATE.log("панель+трансляция: http://localhost:%d" % STREAM_PORT)

    # 2) игровой сервер
    STATE.game_server.start(GAME_PORT)

    # 2b) отдельный сервер СЫРОЙ КАМЕРЫ игрока (картинка DOOMa без UI панели)
    start_raw_server(RAW_PORT)

    # 3) ИИшка
    if not args.no_agent:
        STATE.agent = Agent(STATE)
        loaded = load_population(FEATURE_COUNT)
        if loaded is not None:
            STATE.agent.pop = loaded
            STATE.agent.stats["generation"] = loaded.generation
            STATE.log("загружены мозги: поколение %d" % loaded.generation)
        STATE.agent.start()
        STATE.log("автозапуск ИИшки (на панели можно остановить/паузить/переключить режим)")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        STATE.log("останавливаюсь…")
        if STATE.agent:
            STATE.agent.control("stop")
            save_population(STATE.agent.pop)
            try:
                STATE.agent.join(timeout=5)
            except Exception:
                pass
            STATE.browser.close()
        STATE.game_server.stop()
        httpd.shutdown()


if __name__ == "__main__":
    main()
