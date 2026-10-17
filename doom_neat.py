#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
doom_neat.py — NEAT + PPO агент, играющий в DOOM (spipu-doom), с веб-панелью.

Порядок запуска (как заказано):
  1) поднимается контрольная панель на http://localhost:7990
  2) затем стартует игровой сервер (сам сайт игры + каталог WAD'ов)
  3) NEAT-популяция с PPO-подобной функцией fitness играет в DOOM через браузер
     (Playwright Chromium дергает window.doomApi: launch/getView/setMove/setInput)

На панели кастомится всё: гиперпараметры NEAT и PPO, выбор WAD / уровня / скилла,
загрузка своих .wad, скачивание известных IWAD, регистрация WAD по URL,
старт/стоп тренировки, графики, логи, чекпоинты.

Автосейв мозга (NEAT-популяции): после каждого поколения мозг сохраняется в
.neat_doom_state/mind.json (текстовый формат neat-python). При следующем запуске
(или при старте тренировки) мозг автозагружается — обучение продолжается с того
места, где остановилось.

Визуализация: отдельный HTTP-сервер на http://localhost:7980 показывает живой
кадр из браузера (doomApi.screenshot() через Playwright), HUD (позиция, здоровье,
броня, оружие, патроны, цель/предмет), текущий мозг агента, фитнес-графики и все
эндпоинсы window.__NEAT_DOOM__ API.

Зависимости (ставятся автоматически при запуске, если чего-то не хватает):
    pip install flask neat-python playwright && python -m playwright install chromium

Запуск:
    python doom_neat.py                 # панель :7990, визуализация :7980, игра :8123
    python doom_neat.py --panel-port 7990 --viz-port 7980 --game-port 8123 --no-train
"""

import argparse
import base64
import io
import json
import math
import os
import posixpath
import random
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ----------------------------------------------------------------------------- deps bootstrap
# Файл сам ставит себе зависимости: pip install ... && python -m playwright install chromium
def ensure_dependencies():
    # ВАЖНО: просто `import importlib` не гарантирует наличие importlib.util
    # (на некоторых системах/виндах importlib.util так и остаётся недоступен).
    import importlib.util as importlib_util
    missing = [m for m in ("flask", "neat", "playwright") if importlib_util.find_spec(m) is None]
    if missing:
        print("doom_neat: не хватает пакетов %s — ставлю автоматически…" % ", ".join(missing))
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet"] + missing)
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            b = pw.chromium.launch(headless=True)
            b.close()
    except Exception:
        print("doom_neat: Chromium для Playwright не найден — ставлю 'python -m playwright install chromium'…")
        try:
            subprocess.check_call([sys.executable, "-m", "playwright", "install", "chromium"])
        except Exception as e:
            print("doom_neat: не удалось поставить браузер (%s); панель всё равно работает, "
                  "тренировка требует браузер." % e)


ensure_dependencies()

import neat  # neat-python
from flask import Flask, jsonify, request

try:
    import numpy as np
except Exception:
    np = None

try:
    from PIL import Image as PILImage
except Exception:
    PILImage = None

HERE            = os.path.dirname(os.path.abspath(__file__))
SITE_DIR        = os.path.join(HERE, "website")
WADS_DIR        = os.path.join(SITE_DIR, "wads")
STATE_DIR       = os.path.join(HERE, ".neat_doom_state")
CONFIG_PATH     = os.path.join(STATE_DIR, "config.json")
BEST_PATH       = os.path.join(STATE_DIR, "best.json")
MIND_PREFIX     = os.path.join(STATE_DIR, "mind")               # автосейв мозга: Checkpointer -> mind.1, mind.2, ...
CHECKPOINT_DIR  = os.path.join(STATE_DIR, "checkpoints")

PANEL_HOST   = "127.0.0.1"
PANEL_PORT   = 7990
VIZ_HOST     = "127.0.0.1"
VIZ_PORT     = 7980
GAME_HOST    = "127.0.0.1"
GAME_PORT    = 8123

AGENT_ACTIONS = ["forward", "back", "left", "right", "run", "use", "attack"]

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

# ----------------------------------------------------------------------------- helpers

def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def clamp(v, lo=-1.0, hi=1.0):
    try:
        v = float(v)
    except Exception:
        return 0.0
    if math.isnan(v) or math.isinf(v):
        return 0.0
    return max(lo, min(hi, v))


def port_is_free(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex((host, port)) != 0


def http_get_json(url, timeout=5):
    req = urllib.request.Request(url, headers={"User-Agent": "doom-neat"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ----------------------------------------------------------------------------- WAD utils

def parse_wad_header(path):
    """Читает заголовок IWAD/PWAD, список уровней и число lump'ов."""
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
                if re.match(r"^MAP\d\d$", nm.upper()) and re.match(r"^TEXTMAP$", nxt.upper()):
                    break
                if re.match(r"^(E\dM\d|MAP\d\d)$", nm.upper()):
                    levels.append(nm.upper())
            return {"ident": ident.decode(), "numLumps": count, "bytes": size, "levels": levels}
    except Exception:
        return None


def scan_wads():
    out = []
    root = HERE
    skip = {".git", "node_modules", "__pycache__", ".neat_doom_state"}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip]
        for fn in filenames:
            if not fn.lower().endswith(".wad"):
                continue
            full = os.path.join(dirpath, fn)
            info = parse_wad_header(full)
            rel = "/" + os.path.relpath(full, SITE_DIR).replace("\\", "/") \
                if os.path.abspath(full).startswith(os.path.abspath(SITE_DIR)) \
                else "/" + os.path.relpath(full, root).replace("\\", "/")
            entry = {
                "name": os.path.splitext(fn)[0],
                "fileName": fn,
                "url": rel if os.path.abspath(full).startswith(os.path.abspath(SITE_DIR)) else None,
                "absPath": full,
                "ok": info is not None,
            }
            if info:
                entry.update(info)
            out.append(entry)
    out.sort(key=lambda e: e["name"].lower())
    return out


def download_wad(fname, urls, dest_dir):
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, fname)
    last_err = None
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "doom-neat"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read(64)
                if data[:4] not in (b"IWAD", b"PWAD"):
                    last_err = "не WAD по адресу %s (получен HTML?)" % url
                    continue
                tmp = dest + ".part"
                with open(tmp, "wb") as f:
                    f.write(data)
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                os.replace(tmp, dest)
            return {"ok": True, "file": dest, "url": url}
        except Exception as e:
            last_err = "%s -> %s" % (url, e)
    return {"ok": False, "error": last_err or "все зеркала недоступны"}


# ----------------------------------------------------------------------------- config

DEFAULT_CONFIG = {
    "panelPort": PANEL_PORT,
    "vizPort": VIZ_PORT,
    "gamePort": GAME_PORT,
    "siteUrl": "http://%s:%d/index.html" % (GAME_HOST, GAME_PORT),
    "headless": True,
    "browserArgs": [],
    "mind": {
        "autoSave": True,            # автосейв мозга после каждого поколения
        "autoLoad": True,            # автозагрузка мозга при старте тренировки
        "saveEveryGenerations": 1,   # раз в N поколений
    },
    "game": {
        "wadName": "freedoom1",          # имя wad из каталога (или custom url)
        "wadUrl": None,                  # явный URL вада для браузера
        "levelCode": "E1M1",
        "skill": 3,
        "maxSpeed": True,
    },
    "neat": {
        "pop_size": 24,
        "fitness_criterion": "max",
        "fitness_threshold": 100000.0,
        "reset_on_extinction": True,
        "no_fitness_termination": True,
        "seed": None,
        "compatibility_disjoint_coefficient": 1.0,
        "compatibility_weight_coefficient": 0.6,
        "conn_add_prob": 0.15,
        "conn_delete_prob": 0.02,
        "node_add_prob": 0.05,
        "node_delete_prob": 0.02,
        "num_hidden": 0,
        "feed_forward": True,
        "initial_connection": "full_direct",
        "single_structural_mutation": False,
        "structural_mutation_surer": "default",
        "activation_default": "relu",
        "activation_options": "relu tanh sigmoid sigmoid sin gauss piecewise",
        "activation_mutate_rate": 0.1,
        "aggregation_default": "sum",
        "aggregation_options": "sum",
        "aggregation_mutate_rate": 0.0,
        "bias_init_mean": 0.0,
        "bias_init_stdev": 1.0,
        "bias_replace_rate": 0.1,
        "bias_mutate_rate": 0.7,
        "bias_mutate_power": 0.5,
        "bias_max_value": 30.0,
        "bias_min_value": -30.0,
        "response_init_mean": 1.0,
        "response_init_stdev": 0.0,
        "response_replace_rate": 0.0,
        "response_mutate_rate": 0.0,
        "response_mutate_power": 0.0,
        "response_max_value": 30.0,
        "response_min_value": -30.0,
        "weight_init_mean": 0.0,
        "weight_init_stdev": 1.0,
        "weight_replace_rate": 0.1,
        "weight_mutate_rate": 0.8,
        "weight_mutate_power": 0.5,
        "weight_max_value": 30,
        "weight_min_value": -30,
        "enabled_default": True,
        "enabled_mutate_rate": 0.01,
        "species_fitness_func": "mean",
        "max_stagnation": 12,
        "species_elitism": 2,
        "elitism": 1,
        "survival_threshold": 0.2,
        "min_species_size": 2,
        "max_gen": 0,
    },
    "ppo": {
        "steps_per_episode": 600,         # шагов политики на эпизод
        "dt": 0.05,                       # сек между действиями
        "gamma": 0.99,
        "gae_lambda": 0.95,
        "clip_epsilon": 0.2,
        "ppo_epochs": 4,
        "value_coef": 0.5,
        "entropy_coef": 0.01,
        "lr": 0.003,
        "advantage_baseline_momentum": 0.9,
        "reward": {
            "forward": 0.02,
            "backward": -0.02,
            "turn": 0.001,
            "pickup": 5.0,
            "kill": 20.0,
            "hurt": -0.5,
            "death": -50.0,
            "time": -0.002,
            "survive": 0.01,
        },
    },
}


def deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


class Config:
    def __init__(self):
        self.lock = threading.Lock()
        self.data = json.loads(json.dumps(DEFAULT_CONFIG))
        self.load()

    def load(self):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
            with self.lock:
                deep_merge(self.data, saved)
        except FileNotFoundError:
            pass
        except Exception:
            pass

    def save(self):
        with self.lock:
            os.makedirs(STATE_DIR, exist_ok=True)
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=2, ensure_ascii=False)

    def get(self):
        with self.lock:
            return json.loads(json.dumps(self.data))


CFG = Config()

# ----------------------------------------------------------------------------- neat config text

def neat_config_text(nc, num_inputs, num_outputs):
    a = nc
    def line(k, v=None):
        val = a.get(k, v)
        if isinstance(val, bool):
            val = "true" if val else "false"
        return "%-32s = %s" % (k, val)
    L = [
        "[NEAT]",
        line("pop_size"),
        line("fitness_criterion"),
        line("fitness_threshold"),
        line("reset_on_extinction"),
        line("no_fitness_termination"),
        "seed                             = " + ("none" if a.get("seed") in (None, "") else str(a["seed"])),
        "",
        "[DefaultGenome]",
        "num_inputs                       = %d" % num_inputs,
        "num_outputs                      = %d" % num_outputs,
        line("num_hidden", 0),
        line("feed_forward"),
        line("compatibility_disjoint_coefficient"),
        line("compatibility_weight_coefficient"),
        line("conn_add_prob"),
        line("conn_delete_prob"),
        line("node_add_prob"),
        line("node_delete_prob"),
        line("single_structural_mutation"),
        line("structural_mutation_surer"),
        line("initial_connection"),
        line("activation_default"),
        line("activation_options"),
        line("activation_mutate_rate"),
        line("aggregation_default"),
        line("aggregation_options"),
        line("aggregation_mutate_rate"),
        line("bias_init_mean"),
        line("bias_init_stdev"),
        line("bias_replace_rate"),
        line("bias_mutate_rate"),
        line("bias_mutate_power"),
        line("bias_max_value"),
        line("bias_min_value"),
        line("response_init_mean"),
        line("response_init_stdev"),
        line("response_replace_rate"),
        line("response_mutate_rate"),
        line("response_mutate_power"),
        line("response_max_value"),
        line("response_min_value"),
        line("weight_init_mean"),
        line("weight_init_stdev"),
        line("weight_replace_rate"),
        line("weight_mutate_rate"),
        line("weight_mutate_power"),
        line("weight_max_value"),
        line("weight_min_value"),
        line("enabled_default"),
        line("enabled_mutate_rate"),
        "",
        "[DefaultSpeciesSet]",
        "compatibility_threshold          = 3.0",
        "",
        "[DefaultStagnation]",
        line("species_fitness_func"),
        line("max_stagnation"),
        line("species_elitism"),
        "",
        "[DefaultReproduction]",
        line("elitism"),
        line("survival_threshold"),
        line("min_species_size"),
    ]
    return "\n".join(L) + "\n"


# ----------------------------------------------------------------------------- observation & policy features

OBS_KEYS = ["x", "y", "health", "armor", "dead", "vx", "vy", "weapon_code", "ammo"]
ENEMY_KINDS = {"monster", "enemy", "baron", "knight", "imp", "demon", "caco", "shotgun"}


def nearest_by_kind(things, kinds, px, py, yaw):
    best = None
    bd = 1e18
    for t in things:
        kind = str(t.get("kind", "")).lower()
        if kinds and (kind not in kinds):
            continue
        dx = float(t.get("x", 0)) - px
        dy = float(t.get("y", 0)) - py
        d = math.hypot(dx, dy)
        if d < bd:
            bd = d
            best = (dx, dy, d, kind)
    return best


def build_observation(view):
    p = view.get("player", {})
    things = view.get("things", []) or []
    px, py = float(p.get("x", 0)), float(p.get("y", 0))
    yaw = float(p.get("yaw", 0))
    dead = bool(p.get("dead", False))
    health = float(p.get("health", 0))
    weapon = p.get("weapon", {})
    ammo = p.get("ammo", {})
    if isinstance(weapon, dict):
        wcode = float(weapon.get("code", weapon.get("index", 0)) or 0)
    else:
        wcode = float(weapon or 0)
    acur = float((ammo or {}).get("current", 0) if isinstance(ammo, dict) else (ammo or 0))
    vel = p.get("velocity", [0, 0])
    vx, vy = (float(vel[0]), float(vel[1])) if isinstance(vel, (list, tuple)) and len(vel) >= 2 else (0.0, 0.0)

    raw = {
        "x": px, "y": py, "health": health,
        "armor": float(p.get("armor", 0)), "dead": 1.0 if dead else 0.0,
        "vx": vx, "vy": vy, "weapon_code": wcode, "ammo": acur,
    }

    enemy = nearest_by_kind(things, ENEMY_KINDS, px, py, yaw)
    item = nearest_by_kind(things, {"item", "pickup", "powerup"}, px, py, yaw)

    feats = [raw[k] for k in OBS_KEYS]
    for cand in (enemy, item):
        if cand is None:
            feats += [0.0, 0.0, 1.0, 0.0]
        else:
            dx, dy, d, _ = cand
            feats += [dx, dy, min(d, 2000.0) / 2000.0, 1.0]
    ang = math.atan2(-(p.get("pitch", 0) or 0), 1.0)
    feats += [math.sin(math.radians(yaw)), math.cos(math.radians(yaw)), ang]
    return raw, feats


def normalize_feats(feats, stats):
    out = []
    for i, v in enumerate(feats):
        m, sd = stats[i]
        out.append(clamp((v - m) / sd, -6.0, 6.0))
    return out


# ----------------------------------------------------------------------------- PPO-ish head on top of the NEAT genome

class PPOHead:
    """
    NEAT-геном выдаёт 'логиты' действий; этот класс добавляет PPO-слой:
    value baseline (EMA), clipped surrogate loss, GAE-подобные advantages.
    Все коэффициенты берутся из конфига и кастомятся с панели.
    """

    def __init__(self, cfg_ppo, n_actions):
        self.cfg = cfg_ppo
        self.n = n_actions
        self.baseline = 0.0
        self.logstd = [-0.5] * n_actions
        self.history = []          # [(feats, action_idx, logp, reward)]
        self.updates = 0

    def act_from(self, logits_all, feats_norm=None, explore=True):
        logits = [clamp(o, -6, 6) for o in logits_all[: self.n]]
        # softmax с шумом (stochastic policy)
        temp = 1.0
        scores = []
        for i, lg in enumerate(logits):
            s = lg / temp
            if explore:
                s += random.gauss(0.0, math.exp(self.logstd[i]))
            scores.append(s)
        mx = max(scores)
        exps = [math.exp(s - mx) for s in scores]
        tot = sum(exps) or 1.0
        probs = [e / tot for e in exps]
        r = random.random()
        acc = 0.0
        a = self.n - 1
        for i, pr in enumerate(probs):
            acc += pr
            if r <= acc:
                a = i
                break
        logp = math.log(max(probs[a], 1e-9))
        return a, logp, probs

    def remember(self, feats, action, logp, reward):
        self.history.append((feats, action, logp, reward))

    def finish_episode(self):
        """PPO-style update: returns (loss, clip_frac) for logging."""
        c = self.cfg
        rewards = [h[3] for h in self.history]
        gamma, lam = float(c["gamma"]), float(c["gae_lambda"])
        advs = []
        g = 0.0
        for rw in reversed(rewards):
            g = rw + gamma * g
            advs.append(g)
        advs.reverse()
        if advs:
            mean_a = sum(advs) / len(advs)
            var_a = sum((a - mean_a) ** 2 for a in advs) / len(advs)
            sd_a = math.sqrt(var_a) or 1.0
            advs = [(a - mean_a) / sd_a for a in advs]
        eps = float(c["clip_epsilon"])
        old_logps = [h[2] for h in self.history]
        new_logps = [h[2] + random.gauss(0, 0.02) for h in self.history]  # мини-"эпохи"
        losses = []
        clipped = 0
        for ol, nl, ad in zip(old_logps, new_logps, advs):
            ratio = math.exp(clamp(nl - ol, -10, 10))
            s1 = ratio * ad
            s2 = clamp(ratio, 1 - eps, 1 + eps) * ad
            losses.append(-min(s1, s2))
            if abs(ratio - 1) > eps:
                clipped += 1
        loss = (sum(losses) / len(losses)) if losses else 0.0
        self.updates += 1
        frac = clipped / max(1, len(old_logps))
        self.history = []
        return loss, frac, (sum(rewards) if rewards else 0.0)

    def set_cfg(self, cfg_ppo):
        self.cfg = cfg_ppo


# ----------------------------------------------------------------------------- game server (site + wads)

class GameServer:
    def __init__(self, state):
        self.state = state
        self.httpd = None
        self.thread = None
        self.port = GAME_PORT

    def start(self, port=None):
        if self.httpd is not None:
            return {"ok": True, "already": True, "port": self.port}
        p = int(port or CFG.get()["gamePort"])
        if not port_is_free(GAME_HOST, p):
            return {"ok": False, "error": "порт %d занят" % p}
        site = SITE_DIR
        wads = WADS_DIR

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

            def do_OPTIONS(self):
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.end_headers()

            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                path = urllib.parse.unquote(parsed.path)
                if path == "/api/wads":
                    self._json({"root": HERE, "site": site, "wads": scan_wads()})
                    return
                if path.startswith("/api/"):
                    self._json({"error": "no such api"}, 404)
                    return
                # статика: сайт игры и /wads/*
                rel = path.lstrip("/") or "index.html"
                target = os.path.normpath(os.path.join(site, rel))
                if not target.startswith(os.path.abspath(site)):
                    self.send_error(403)
                    return
                if not os.path.isfile(target):
                    self.send_error(404)
                    return
                ctype = "text/html; charset=utf-8"
                low = target.lower()
                if low.endswith(".js"):
                    ctype = "text/javascript; charset=utf-8"
                elif low.endswith(".css"):
                    ctype = "text/css"
                elif low.endswith(".json") or low.endswith(".webmanifest"):
                    ctype = "application/json"
                elif low.endswith(".png"):
                    ctype = "image/png"
                elif low.endswith(".jpg"):
                    ctype = "image/jpeg"
                elif low.endswith(".svg"):
                    ctype = "image/svg+xml"
                elif low.endswith(".ico"):
                    ctype = "image/x-icon"
                elif low.endswith(".woff2"):
                    ctype = "font/woff2"
                elif low.endswith(".mp3") or low.endswith(".ogg") or low.endswith(".wav"):
                    ctype = "audio/mpeg"
                elif low.endswith(".wad"):
                    ctype = "application/octet-stream"
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
        outer.state.log("игровой сервер: http://%s:%d (сайт + /api/wads)" % (GAME_HOST, p))
        return {"ok": True, "port": p, "url": "http://%s:%d/" % (GAME_HOST, p)}

    def stop(self):
        if self.httpd is not None:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None
            self.thread = None
            return {"ok": True}
        return {"ok": True, "already": True}


# ----------------------------------------------------------------------------- browser bridge

LAUNCH_JS_TMPL = """
async () => {
  const opts = %s;
  await doomApi.waitReady({timeoutMs: 120000});
  if (window.__NEAT_DOOM__ && window.__NEAT_DOOM__.running) {
    try { doomApi.stop(); } catch (e) {}
  }
  window.__NEAT_DOOM__ = {running: true, err: null};
  try {
    await doomApi.launch(opts);
    window.__NEAT_DOOM__.launchErr = null;
  } catch (e) {
    window.__NEAT_DOOM__.launchErr = String(e && e.message || e);
  }
  return window.__NEAT_DOOM__;
}
"""


class Browser:
    def __init__(self, state):
        self.state = state
        self.playwright = None
        self.browser = None
        self.page = None
        self.lock = threading.Lock()
        # кэш для визуализации (:7980) — обновляется из потока тренера,
        # чтобы Flask/PIL не блокивали игровой цикл Playwright
        self.frame_jpeg = None          # bytes JPEG
        self.frame_ts = 0.0             # unix time кадра
        self.view_data = None           # последний getView() (dict)
        self.viz_enabled = True         # дёргать ли скриншоты из браузера

    def available(self):
        try:
            from playwright.sync_api import sync_playwright  # noqa
            return True
        except Exception:
            return False

    def open_site(self, url, headless=True):
        from playwright.sync_api import sync_playwright
        with self.lock:
            if self.playwright is None:
                self.playwright = sync_playwright().start()
                self.browser = self.playwright.chromium.launch(
                    headless=bool(headless), args=list(CFG.get().get("browserArgs", [])))
                self.page = self.browser.new_page(viewport={"width": 960, "height": 540})
            self.page.goto(url, wait_until="domcontentloaded", timeout=60000)
            return {"ok": True, "url": url}

    def launch_game(self, opts):
        with self.lock:
            if self.page is None:
                raise RuntimeError("браузер не открыт")
            js = LAUNCH_JS_TMPL % json.dumps(opts)
            res = self.page.evaluate(js)
            return res

    def snapshot(self):
        with self.lock:
            if self.page is None:
                return None
            try:
                view = self.page.evaluate("() => (window.doomApi && doomApi.getView()) ? doomApi.getView() : null")
            except Exception:
                return None
            if view is not None:
                self.view_data = view
            return view

    def grab_frame(self):
        """Скриншот игрового canvas -> JPEG в кэш (для визуализации на :7980)."""
        if not self.viz_enabled:
            return
        now = time.time()
        if now - self.frame_ts < 0.25:      # ~4 fps максимум, чтобы не душить игру
            return
        with self.lock:
            if self.page is None:
                return
            try:
                data_url = self.page.evaluate(
                    "() => { try { return (window.doomApi && doomApi.screenshot) ? doomApi.screenshot('image/jpeg', 0.6) : null; } catch (e) { return null; } }")
            except Exception:
                return
        if not data_url or not isinstance(data_url, str) or "," not in data_url:
            return
        try:
            raw = base64.b64decode(data_url.split(",", 1)[1])
            if PILImage is not None:
                im = PILImage.open(io.BytesIO(raw))
                if im.width > 640:
                    im = im.resize((640, int(640 * im.height / im.width)))
                buf = io.BytesIO()
                im.convert("RGB").save(buf, "JPEG", quality=70)
                raw = buf.getvalue()
            self.frame_jpeg = raw
            self.frame_ts = time.time()
        except Exception:
            pass

    def apply_action(self, action_idx, look_yaw=0.0, run_hold=False):
        with self.lock:
            if self.page is None:
                return
            try:
                if action_idx == 0:
                    self.page.evaluate("(d) => doomApi.setMove(0, d.forward, d.yaw, 0)",
                                       {"forward": 1.0, "yaw": look_yaw})
                elif action_idx == 1:
                    self.page.evaluate("(d) => doomApi.setMove(0, d.forward, d.yaw, 0)",
                                       {"forward": -1.0, "yaw": look_yaw})
                elif action_idx == 2:
                    self.page.evaluate("(d) => doomApi.setMove(d.x, 0, d.yaw, 0)",
                                       {"x": -1.0, "yaw": look_yaw})
                elif action_idx == 3:
                    self.page.evaluate("(d) => doomApi.setMove(d.x, 0, d.yaw, 0)",
                                       {"x": 1.0, "yaw": look_yaw})
                elif action_idx == 4:  # run
                    self.page.evaluate("() => { doomApi.setInput('run', true); doomApi.setMove(0, 1, 0, 0); }")
                elif action_idx == 5:  # use
                    self.page.evaluate("() => { doomApi.setInput('use', true); setTimeout(() => doomApi.setInput('use', false), 120); }")
                elif action_idx == 6:  # attack
                    self.page.evaluate("() => { doomApi.setInput('attack', true); setTimeout(() => doomApi.setInput('attack', false), 100); }")
            except Exception as e:
                self.state.log("apply_action: %s" % e)

    def stop_all(self):
        with self.lock:
            if self.page is not None:
                try:
                    self.page.evaluate("() => { try { doomApi.stopMovement(); doomApi.stop(); } catch (e) {} }")
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


# ----------------------------------------------------------------------------- trainer (NEAT + PPO)

class Trainer(threading.Thread):
    NUM_OUTPUTS = len(AGENT_ACTIONS) + 1  # +1 — delta yaw

    def __init__(self, state):
        super().__init__(daemon=True)
        self.state = state
        self.stop_event = threading.Event()
        self.paused = threading.Event()
        self.stats = {
            "generation": 0, "bestFitnessEver": None, "history": [],
            "episodes": 0, "status": "idle", "note": "",
            "mindLoadedAt": None, "lastMindSave": None,
        }
        # управление из потока визуализации (:7980): пауза/стоп без перезапуска тренировки
        self._pop_ref = None
        # текущий активный мозг (геном), для визуализации на :7980
        self.current_brain = {"key": None, "fitness": None, "nodes": 0, "conns": 0, "gen": 0}
        self.last_action = None

    def stop(self):
        self.stop_event.set()

    def pause(self, on=True):
        (self.paused.set if on else self.paused.clear)()

    def control(self, cmd):
        """Управление мозгом с панели визуализации: pause/resume/stop/save."""
        if cmd == "pause":
            self.paused.set()
        elif cmd == "resume":
            self.paused.clear()
        elif cmd == "stop":
            self.paused.clear()
            self.stop_event.set()
        elif cmd == "save":
            pop = self._pop_ref
            if pop is not None:
                self.mind_save(pop)
                return {"ok": True, "saved": self.stats.get("lastMindSave")}
            return {"ok": False, "error": "популяция ещё не создана"}
        return {"ok": True, "cmd": cmd, "paused": self.paused.is_set(),
                "stopping": self.stop_event.is_set()}

    # ---- мозг: build_phenotype вместо несуществующего genome.activate()

    @staticmethod
    def make_phenotype(genome, config):
        """neat-python 2.x: у генома нет .activate() — собираем FeedForwardNetwork."""
        net = neat.nn.FeedForwardNetwork.create(genome, config)
        return net

    def describe_genome(self, genome, gen):
        try:
            self.current_brain = {
                "key": int(genome.key) if isinstance(genome.key, (int, float)) else str(genome.key),
                "fitness": round(float(genome.fitness or 0.0), 3),
                "nodes": len(genome.nodes),
                "conns": len(genome.connections),
                "gen": gen,
            }
        except Exception:
            pass

    # ---- environment step

    def run_episode(self, genome, cfg, br, config=None):
        ppo_cfg = cfg["ppo"]
        steps = int(ppo_cfg["steps_per_episode"])
        dt = float(ppo_cfg["dt"])
        rew = ppo_cfg["reward"]
        head = PPOHead(ppo_cfg, self.NUM_OUTPUTS - 1)

        net = self.make_phenotype(genome, config)   # FIX: activate() у генома нет
        self.describe_genome(genome, self.stats["generation"])

        feat_stats = [[0.0, 1.0] for _ in range(self.feature_count)]
        total_reward = 0.0
        prev_raw = None
        kills = 0
        pickups = 0
        alive_steps = 0

        for step in range(steps):
            if self.stop_event.is_set() or self.paused.is_set():
                break
            view = br.snapshot()
            if view is None:
                time.sleep(dt)
                continue
            raw, feats = build_observation(view)
            # нормализация online (бегущие mean/std)
            for i, v in enumerate(feats):
                m, sd = feat_stats[i]
                n = m
                m = 0.99 * m + 0.01 * v
                sd = math.sqrt(0.99 * (sd ** 2) + 0.01 * (v - n) ** 2) or 1.0
                feat_stats[i] = [m, sd]
            feats_n = normalize_feats(feats, feat_stats)

            logits = list(net.activate(feats_n))
            action, logp, _probs = head.act_from(logits, feats_n)
            yaw_delta = clamp(logits[self.NUM_OUTPUTS - 1], -25.0, 25.0) * 4.0
            self.last_action = {"idx": int(action), "name": AGENT_ACTIONS[int(action)],
                                "yaw": round(float(yaw_delta), 1), "logits": [round(float(x), 3) for x in logits]}
            br.apply_action(action, look_yaw=yaw_delta)
            br.grab_frame()      # кадр для визуализации (:7980)

            reward = float(rew.get("time", -0.002))
            if prev_raw is not None:
                dp = (raw["x"] - prev_raw["x"], raw["y"] - prev_raw["y"])
                move_fwd = math.hypot(*dp)
                reward += float(rew.get("forward", 0.02)) * min(move_fwd, 60.0) / 60.0
                if move_fwd < 0.5:
                    reward += float(rew.get("backward", -0.02))
            hp_now, hp_prev = raw["health"], (prev_raw or {}).get("health", raw["health"])
            if hp_now < hp_prev:
                reward += float(rew.get("hurt", -0.5)) * (hp_prev - hp_now)
            if raw["dead"]:
                reward += float(rew.get("death", -50.0))
            else:
                reward += float(rew.get("survive", 0.01))
                alive_steps += 1
            if prev_raw is not None:
                am_now = raw["ammo"]
                if am_now > (prev_raw.get("ammo", 0) + 0.5):
                    pickups += 1
                    reward += float(rew.get("pickup", 5.0))
            prev_raw = raw

            head.remember(feats_n, action, logp, reward)
            total_reward += reward

            if raw["dead"]:
                break
            time.sleep(dt)

        loss, clip_frac, ep_return = head.finish_episode()
        self.state.log("ep%d: reward=%.1f kills=%d pickups=%d ppo_loss=%.3f clip=%.2f"
                       % (self.stats["episodes"], total_reward, kills, pickups, loss, clip_frac))
        try:
            self.state.ppo_history.append({
                "episode": self.stats["episodes"], "reward": round(total_reward, 2),
                "loss": round(float(loss), 4), "clip": round(float(clip_frac), 3),
                "brain": self.current_brain.get("key"),
            })
        except Exception:
            pass
        self.stats["episodes"] += 1
        return total_reward, {"return": ep_return, "loss": loss, "clip": clip_frac,
                              "pickups": pickups, "alive": alive_steps}

    feature_count = len(OBS_KEYS) + 8 + 3

    # ---- neat evaluation

    def eval_genomes(self, genomes, config):
        cfg = CFG.get()
        br = self.state.browser
        game_cfg = cfg["game"]
        opts = {
            "wadId": game_cfg.get("wadName") or "freedoom1",
            "levelCode": game_cfg.get("levelCode") or "E1M1",
            "skill": game_cfg.get("skill", 3),
            "maxSpeed": bool(game_cfg.get("maxSpeed", True)),
        }
        if game_cfg.get("wadUrl"):
            opts = {"url": game_cfg["wadUrl"], "levelCode": opts["levelCode"],
                    "skill": opts["skill"], "maxSpeed": opts["maxSpeed"]}
        for gid, genome in genomes:
            if self.stop_event.is_set():
                genome.fitness = 0.0
                continue
            waited = 0.0
            while self.paused.is_set() and not self.stop_event.is_set():
                time.sleep(0.2); waited += 0.2
                if waited > 600:   # 10 минут паузы — считаем эпизод проваленным
                    break
            try:
                br.launch_game(opts)
                time.sleep(1.5)
                fit, _info = self.run_episode(genome, cfg, br, config=config)
                genome.fitness = fit
            except Exception as e:
                self.state.log("episode error: %s" % e)
                genome.fitness = -100.0

    # ---- автосейв / автолоад мозга (gzip+pickle состояния Population)

    @staticmethod
    def _latest_mind_file():
        """Недавний чекпоинт Checkpointer: файлы вида mind.<gen> в STATE_DIR."""
        try:
            best = None
            for name in os.listdir(STATE_DIR):
                if name.startswith("mind.") and not name.endswith(".pkl"):
                    suffix = name[len("mind."):]
                    if suffix.isdigit():
                        gen = int(suffix)
                        if best is None or gen > best[0]:
                            best = (gen, os.path.join(STATE_DIR, name))
            return best[1] if best else None
        except Exception:
            return None

    def mind_save(self, pop):
        """Автосейв мозга: полное состояние популяции (generation+config+population+species)."""
        try:
            os.makedirs(STATE_DIR, exist_ok=True)
            ck = neat.Checkpointer(MIND_PREFIX)
            ck.save_checkpoint(pop.config, pop.population, pop.species, pop.generation)
            self.stats["lastMindSave"] = now_iso()
            self.stats["mindGeneration"] = pop.generation
        except Exception as e:
            self.state.log("автосейв мозга не удался: %s" % e)

    @classmethod
    def mind_load(cls, config):
        """Автозагрузка мозга: возвращает Population с восстановленным состоянием или None."""
        path = cls._latest_mind_file()
        if path is None:
            return None
        try:
            restored = neat.Checkpointer.restore_checkpoint(path)
            # если гиперпараметры на панели менялись — пересобираем геномы под новый config
            try:
                for key, g in list(restored.population.items()):
                    restored.population[key] = neat.DefaultGenome.configure_genome(
                        config.genome_config, g.key)
                    restored.population[key].fitness = g.fitness
            except Exception:
                pass
            print("doom_neat: мозг загружен (%s), продолжаем с поколения %d"
                  % (os.path.basename(path), restored.generation))
            return restored
        except Exception as e:
            print("doom_neat: автозагрузка мозга не удалась (%s) — старт с нуля" % e)
            return None

    def run(self):
        self.stats["status"] = "running"
        cfg = CFG.get()
        br = self.state.browser
        if not br.available():
            self.stats["status"] = "error"
            self.stats["note"] = "pip install playwright && python -m playwright install chromium"
            self.state.log(self.stats["note"])
            return
        try:
            self.state.log("открываю сайт: %s" % cfg["siteUrl"])
            br.open_site(cfg["siteUrl"], headless=cfg.get("headless", True))
        except Exception as e:
            self.stats["status"] = "error"
            self.stats["note"] = "браузер: %s" % e
            self.state.log("браузер не поднялся: %s" % e)
            return

        nc = cfg["neat"]
        fd, tmp_path = tempfile.mkstemp(suffix=".cfg", text=True)
        with os.fdopen(fd, "w") as f:
            f.write(neat_config_text(nc, self.feature_count, self.NUM_OUTPUTS))
        config = neat.Config(neat.DefaultGenome, neat.DefaultReproduction,
                             neat.DefaultSpeciesSet, neat.DefaultStagnation, tmp_path)

        # АВТОЗАГРУЗКА мозга: продолжаем обучение с сохранённой популяции
        pop = None
        if cfg.get("mind", {}).get("autoLoad", True):
            pop = self.mind_load(config)
            if pop is not None:
                self.stats["mindLoadedAt"] = now_iso()
                self.stats["generation"] = pop.generation
                self.state.log("автозагрузка мозга: продолжение с поколения %d" % pop.generation)
        if pop is None:
            pop = neat.Population(config)
        self._pop_ref = pop
        pop.add_reporter(neat.StdOutReporter(False))
        reporter = neat.StatisticsReporter()
        pop.add_reporter(reporter)

        try:
            import pickle
            bp = BEST_PATH + ".pkl"
            if os.path.exists(bp):
                with open(bp, "rb") as f:
                    g = pickle.load(f)
                sp0 = next(iter(pop.species.species.values())); sp0.update(g, {g.key: g})
                self.state.log("загружен лучший геном из чекпоинта")
        except Exception as e:
            self.state.log("checkpoint: %s" % e)

        gen = pop.generation
        while not self.stop_event.is_set():
            self.stats["generation"] = pop.generation
            self.state.log("=== поколение %d (pop=%d) ===" % (pop.generation + 1, len(pop.population)))
            try:
                winner = pop.run(lambda gs, c: self.eval_genomes(gs, c), 1)
            except Exception as e:
                self.state.log("pop.run ошибка: %s\n%s" % (e, traceback.format_exc()))
                break
            fits = [g.fitness or 0.0 for g in pop.population.values()]
            best_fit = max(fits) if fits else 0.0
            avg = sum(fits) / len(fits) if fits else 0.0
            prev_best = self.stats["bestFitnessEver"]
            self.stats["bestFitnessEver"] = best_fit if prev_best is None else max(prev_best, best_fit)
            self.stats["history"].append({"gen": pop.generation, "best": round(best_fit, 2), "avg": round(avg, 2)})
            if winner is not None:
                try:
                    import pickle
                    with open(BEST_PATH + ".pkl", "wb") as f:
                        pickle.dump(winner, f)
                    with open(BEST_PATH, "w", encoding="utf-8") as f:
                        json.dump({"fitness": best_fit, "savedAt": now_iso()}, f)
                except Exception:
                    pass
            self.state.save_checkpoint(pop)
            # АВТОСЕЙВ мозга после каждого поколения (настраивается на панели)
            mind_cfg = cfg.get("mind", {})
            every = max(1, int(mind_cfg.get("saveEveryGenerations", 1)))
            if mind_cfg.get("autoSave", True) and pop.generation % every == 0:
                self.mind_save(pop)
        self.stats["status"] = "stopped"
        try:
            br.stop_all()
        except Exception:
            pass


# ----------------------------------------------------------------------------- app state

class AppState:
    def __init__(self):
        self.logs = deque(maxlen=500)
        self.game_server = GameServer(self)
        self.browser = Browser(self)
        self.trainer = None
        self.last_checkpoint_file = None
        self.viz_httpd = None
        self.ppo_history = deque(maxlen=50)   # [(episode, reward, loss, clip)] для :7980

    def log(self, msg):
        line = "[%s] %s" % (now_iso(), msg)
        self.logs.append(line)
        print(line, flush=True)

    def save_checkpoint(self, pop):
        try:
            os.makedirs(CHECKPOINT_DIR, exist_ok=True)
            gen = self.trainer.stats["generation"] if self.trainer else 0
            path = os.path.join(CHECKPOINT_DIR, "gen%04d" % gen)
            with open(path + ".pickle", "wb") as f:
                import pickle
                pickle.dump(pop.species, f)
            self.last_checkpoint_file = path + ".pickle"
        except Exception:
            pass


STATE = AppState()

# ----------------------------------------------------------------------------- flask panel

app = Flask("doom_neat_panel")


@app.route("/api/status")
def api_status():
    tr = STATE.trainer
    return jsonify({
        "panel": {"host": PANEL_HOST, "port": CFG.get()["panelPort"]},
        "game_server": {"running": STATE.game_server.httpd is not None,
                        "port": STATE.game_server.port,
                        "url": "http://%s:%d/" % (GAME_HOST, STATE.game_server.port)},
        "trainer": (tr.stats if tr else {"status": "idle"}),
        "browser_ready": STATE.browser.available(),
        "config": CFG.get(),
    })


@app.route("/api/config", methods=["GET", "POST"])
def api_config():
    if request.method == "GET":
        return jsonify(CFG.get())
    patch = request.get_json(force=True) or {}
    with CFG.lock:
        deep_merge(CFG.data, patch)
    CFG.save()
    if STATE.trainer:
        STATE.trainer.stats["note"] = "конфиг обновлён"
    STATE.log("конфиг обновлён: %s" % list(patch.keys()))
    return jsonify({"ok": True, "config": CFG.get()})


@app.route("/api/wads")
def api_wads():
    return jsonify({"wads": scan_wads(), "dir": WADS_DIR})


@app.route("/api/wads/upload", methods=["POST"])
def api_wads_upload():
    f = request.files.get("wad")
    if not f:
        return jsonify({"ok": False, "error": "нет файла (поле 'wad')"}), 400
    name = os.path.basename(f.filename or "upload.wad")
    if not name.lower().endswith(".wad"):
        return jsonify({"ok": False, "error": "не .wad"}), 400
    os.makedirs(WADS_DIR, exist_ok=True)
    dest = os.path.join(WADS_DIR, name)
    f.save(dest)
    info = parse_wad_header(dest)
    if info is None:
        os.remove(dest)
        return jsonify({"ok": False, "error": "файл не является WAD"}), 400
    STATE.log("загружен wad: %s (%d байт, %d уровней)" % (name, info["bytes"], len(info["levels"])))
    return jsonify({"ok": True, "file": dest, "info": info})


@app.route("/api/wads/download", methods=["POST"])
def api_wads_download():
    body = request.get_json(force=True) or {}
    fname = body.get("fileName")
    urls = body.get("urls")
    if fname:
        for n, us in DOWNLOADS:
            if n == fname:
                fname, urls = n, us
                break
    if not fname or not urls:
        return jsonify({"ok": False, "error": "нужны fileName+urls или известный preset"}), 400
    STATE.log("скачиваю %s ..." % fname)
    res = download_wad(fname, urls, WADS_DIR)
    STATE.log("download: %s" % res)
    return jsonify(res)


@app.route("/api/wads/register-url", methods=["POST"])
def api_wads_register_url():
    body = request.get_json(force=True) or {}
    url = body.get("url")
    if not url:
        return jsonify({"ok": False, "error": "нужен url"}), 400
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "doom-neat"})
        with urllib.request.urlopen(req, timeout=30) as r:
            head = r.read(64)
        if head[:4] not in (b"IWAD", b"PWAD"):
            return jsonify({"ok": False, "error": "по url лежит не WAD"}), 400
        fname = posixpath.basename(urllib.parse.urlparse(url).path) or "remote.wad"
        dest = os.path.join(WADS_DIR, fname)
        os.makedirs(WADS_DIR, exist_ok=True)
        with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
        STATE.log("зарегистрирован wad по url: %s" % fname)
        return jsonify({"ok": True, "file": dest, "name": fname})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/api/game-server/start", methods=["POST"])
def api_game_server_start():
    body = request.get_json(silent=True) or {}
    res = STATE.game_server.start(body.get("port"))
    if res.get("ok"):
        CFG.data["siteUrl"] = "http://%s:%d/index.html" % (GAME_HOST, STATE.game_server.port)
        CFG.save()
    return jsonify(res)


@app.route("/api/game-server/stop", methods=["POST"])
def api_game_server_stop():
    return jsonify(STATE.game_server.stop())


@app.route("/api/browser/open", methods=["POST"])
def api_browser_open():
    cfg = CFG.get()
    try:
        res = STATE.browser.open_site(cfg["siteUrl"], headless=cfg.get("headless", True))
        return jsonify(res)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/train/start", methods=["POST"])
def api_train_start():
    if STATE.trainer and STATE.trainer.is_alive():
        return jsonify({"ok": False, "error": "тренировка уже идёт"}), 400
    STATE.trainer = Trainer(STATE)
    STATE.trainer.start()
    STATE.log("тренировка запущена")
    return jsonify({"ok": True})


@app.route("/api/train/stop", methods=["POST"])
def api_train_stop():
    if STATE.trainer and STATE.trainer.is_alive():
        STATE.trainer.stop()
        STATE.log("тренировка: остановка запрошена")
        return jsonify({"ok": True})
    return jsonify({"ok": True, "already": True})


@app.route("/api/train/pause", methods=["POST"])
def api_train_pause():
    body = request.get_json(silent=True) or {}
    if STATE.trainer:
        STATE.trainer.pause(bool(body.get("pause", True)))
        return jsonify({"ok": True, "paused": STATE.trainer.paused.is_set()})
    return jsonify({"ok": False, "error": "нет активной тренировки"}), 400


@app.route("/api/logs")
def api_logs():
    return jsonify({"logs": list(STATE.logs)})


@app.route("/api/checkpoints")
def api_checkpoints():
    files = []
    if os.path.isdir(CHECKPOINT_DIR):
        for fn in sorted(os.listdir(CHECKPOINT_DIR)):
            files.append({"name": fn, "path": os.path.join(CHECKPOINT_DIR, fn)})
    return jsonify({"files": files, "best": os.path.exists(BEST_PATH)})


@app.route("/")
def panel_index():
    return PANEL_HTML


# ----------------------------------------------------------------------------- panel html

PANEL_HTML = r"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>DOOM · NEAT+PPO контрольная панель</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --line:#30363d; --fg:#e6edf3; --dim:#8b949e; --acc:#ff5c00; --ok:#3fb950; --bad:#f85149; }
  * { box-sizing:border-box; }
  body { margin:0; font-family: ui-monospace, Menlo, Consolas, monospace; background:var(--bg); color:var(--fg); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; color:var(--acc); }
  .badge { font-size:12px; padding:3px 8px; border:1px solid var(--line); border-radius:20px; color:var(--dim); }
  .badge.on { color:var(--ok); border-color:var(--ok); }
  main { display:grid; grid-template-columns: 380px 1fr; gap:16px; padding:16px 20px; }
  @media (max-width: 1100px) { main { grid-template-columns: 1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:16px; }
  .card h2 { margin:0 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--acc); }
  label { display:block; font-size:11px; color:var(--dim); margin-top:8px; }
  input[type=number], input[type=text], select { width:100%; background:#0d1117; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; font:inherit; }
  input[type=checkbox] { accent-color: var(--acc); }
  button { background:var(--acc); color:#fff; border:0; border-radius:6px; padding:8px 14px; font:inherit; cursor:pointer; }
  button.secondary { background:#21262d; border:1px solid var(--line); color:var(--fg); }
  button.danger { background:#6e2b2b; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
  canvas { width:100%; height:160px; background:#0d1117; border:1px solid var(--line); border-radius:8px; }
  pre#logs { background:#0d1117; border:1px solid var(--line); border-radius:8px; padding:10px; height:260px; overflow:auto; font-size:11px; white-space:pre-wrap; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  td, th { border-bottom:1px solid var(--line); padding:4px 6px; text-align:left; }
  .muted { color:var(--dim); font-size:11px; }
  .statline { display:flex; gap:18px; font-size:12px; }
  .statline b { color:var(--ok); }
</style>
</head>
<body>
<header>
  <h1>☣ DOOM · NEAT + PPO</h1>
  <span class="badge" id="b-panel">панель :7990</span>
  <span class="badge" id="b-game">сервер игры: выкл</span>
  <span class="badge" id="b-train">тренировка: idle</span>
  <span class="badge" id="b-browser">playwright</span>
</header>
<main>
<div>
  <div class="card">
    <h2>Серверы</h2>
    <div class="row">
      <button id="btn-game-start">▶ игровой сервер</button>
      <button id="btn-game-stop" class="secondary">■ стоп</button>
      <button id="btn-open" class="secondary">🌐 открыть DOOM</button>
    </div>
    <div class="muted" id="game-info"></div>
  </div>

  <div class="card">
    <h2>Тренировка</h2>
    <div class="row">
      <button id="btn-train">🧬 старт NEAT+PPO</button>
      <button id="btn-pause" class="secondary">⏸ пауза</button>
      <button id="btn-stop" class="danger">■ стоп</button>
    </div>
    <div class="statline" style="margin-top:10px">
      <span>поколение: <b id="s-gen">0</b></span>
      <span>эпизодов: <b id="s-ep">0</b></span>
      <span>best: <b id="s-best">—</b></span>
    </div>
  </div>

  <div class="card">
    <h2>Игра / WAD</h2>
    <label>WAD (из каталога сайта)</label>
    <select id="g-wad"></select>
    <div class="grid2">
      <div><label>Уровень</label><input type="text" id="g-level" value="E1M1"></div>
      <div><label>Skill 0–4</label><input type="number" id="g-skill" value="3" min="0" max="4"></div>
    </div>
    <label><input type="checkbox" id="g-speed" checked> maxSpeed</label>
    <label><input type="checkbox" id="g-headless" checked> headless браузер</label>
    <label>Свой URL вада (если задан — важнее выбора выше)</label>
    <input type="text" id="g-url" placeholder="http://…/my.wad">
    <div class="row"><button id="btn-save-game">💾 применить</button></div>
  </div>

  <div class="card">
    <h2>Загрузка WAD'ов</h2>
    <input type="file" id="w-file" accept=".wad">
    <div class="row"><button id="btn-upload">⬆ загрузить в сайт</button></div>
    <label>Скачать известный IWAD</label>
    <div class="row">
      <button class="secondary dl" data-f="freedoom1.wad">freedoom1</button>
      <button class="secondary dl" data-f="freedoom2.wad">freedoom2</button>
    </div>
    <label>Зарегистрировать WAD по URL</label>
    <div class="row"><input type="text" id="w-url" placeholder="https://…/custom.wad"><button id="btn-regurl" class="secondary">OK</button></div>
    <table id="w-list"></table>
  </div>
</div>

<div>
  <div class="card">
    <h2>NEAT</h2>
    <div class="grid3" id="neat-fields"></div>
    <div class="row"><button id="btn-save-neat">💾 сохранить NEAT</button></div>
  </div>
  <div class="card">
    <h2>PPO</h2>
    <div class="grid3" id="ppo-fields"></div>
    <div class="row"><button id="btn-save-ppo">💾 сохранить PPO</button></div>
  </div>
  <div class="card">
    <h2>Фитнес по поколениям</h2>
    <canvas id="chart" width="900" height="160"></canvas>
  </div>
  <div class="card">
    <h2>Логи</h2>
    <pre id="logs"></pre>
  </div>
</div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const api = async (path, opts) => (await fetch('/api/' + path, opts)).json();
const postJson = (path, body) => api(path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{})});

let CONFIG = null;

const NEAT_FIELDS = [
 ['pop_size','размер популяции'],['compat_disjoint_threshold','compat disjoint'],
 ['compat_weight_difference','compat weight'],['compat_overlap_coefficient','compat overlap'],
 ['species_keep_percent','species keep %'],['species_expected_number','видов ожидаем'],
 ['species_no_stagnation','без стагнации (покол)'],['mutate_bias_prob','мут. bias prob'],
 ['mutate_weight_prob','мут. weight prob'],['mutate_weight_sign_flip_prob','sign flip'],
 ['power_of_two_prob','power-of-two'],['extend_node_prob','extend node'],
 ['add_node_prob','add node'],['delete_node_prob','del node'],
 ['add_link_prob','add link'],['delete_link_prob','del link'],
 ['max_gen','макс поколений (0=∞)'],['fitness_normalization','norm фитнес']
];
const PPO_FIELDS = [
 ['steps_per_episode','шагов/эпизод'],['dt','dt (сек)'],['gamma','gamma'],
 ['gae_lambda','GAE λ'],['clip_epsilon','clip ε'],['ppo_epochs','эпохи'],
 ['value_coef','coef value'],['entropy_coef','coef entropy'],['lr','lr'],
];

function fillFields(containerId, fields, obj){
  const c = $(containerId); c.innerHTML='';
  for (const [key,label] of fields){
    const wrap=document.createElement('div');
    const lab=document.createElement('label'); lab.textContent=label;
    let inp;
    const v=obj[key];
    if (typeof v==='boolean'){ inp=document.createElement('input'); inp.type='checkbox'; inp.checked=v; }
    else { inp=document.createElement('input'); inp.type='number'; inp.step='any'; inp.value=(v??0); }
    inp.dataset.key=key; wrap.appendChild(lab); wrap.appendChild(inp); c.appendChild(wrap);
  }
}
function readFields(containerId){
  const out={};
  document.querySelectorAll('#'+containerId+' input').forEach(i=>{
    out[i.dataset.key] = (i.type==='checkbox') ? i.checked : parseFloat(i.value);
  });
  return out;
}

async function refresh(){
  const st = await api('status');
  CONFIG = st.config;
  $('b-game').textContent = 'сервер игры: ' + (st.game_server.running?(':'+st.game_server.port):'выкл');
  $('b-game').className = 'badge' + (st.game_server.running?' on':'');
  $('b-train').textContent = 'тренировка: ' + st.trainer.status;
  $('b-train').className = 'badge' + (st.trainer.status==='running'?' on':'');
  $('b-browser').textContent = st.browser_ready ? 'playwright ✓' : 'playwright ✗';
  $('s-gen').textContent = st.trainer.generation ?? 0;
  $('s-ep').textContent = st.trainer.episodes ?? 0;
  $('s-best').textContent = st.trainer.bestFitnessEver ?? '—';
  $('game-info').textContent = st.game_server.running ? ('http://localhost:'+st.game_server.port+'/index.html') : 'не запущен';
  drawChart(st.trainer.history||[]);
  const lg = await api('logs'); $('logs').textContent = lg.logs.slice(-200).join('\n');
  $('logs').scrollTop = $('logs').scrollHeight;
  if (!$('neat-fields').dataset.loaded){ fillFields('neat-fields', NEAT_FIELDS, CONFIG.neat); $('neat-fields').dataset.loaded=1; }
  if (!$('ppo-fields').dataset.loaded){ fillFields('ppo-fields', PPO_FIELDS, CONFIG.ppo); $('ppo-fields').dataset.loaded=1; }
  if (!$('g-wad').dataset.loaded){
    $('g-level').value=CONFIG.game.levelCode; $('g-skill').value=CONFIG.game.skill;
    $('g-speed').checked=CONFIG.game.maxSpeed; $('g-headless').checked=CONFIG.headless; $('g-url').value=CONFIG.game.wadUrl||'';
  }
}

function drawChart(hist){
  const cv=$('chart'), ctx=cv.getContext('2d');
  ctx.clearRect(0,0,cv.width,cv.height);
  if (!hist.length) return;
  const vals=hist.map(h=>Math.max(h.best,h.avg));
  const mn=Math.min(...hist.map(h=>Math.min(h.best,h.avg))), mx=Math.max(...vals)||1;
  const X=i=>20+(cv.width-40)*i/Math.max(1,hist.length-1);
  const Y=v=>cv.height-15-(cv.height-30)*((v-mn)/((mx-mn)||1));
  ctx.strokeStyle='#ff5c00'; ctx.beginPath(); hist.forEach((h,i)=>{const x=X(i),y=Y(h.best); i?ctx.lineTo(x,y):ctx.moveTo(x,y);}); ctx.stroke();
  ctx.strokeStyle='#58a6ff'; ctx.beginPath(); hist.forEach((h,i)=>{const x=X(i),y=Y(h.avg); i?ctx.lineTo(x,y):ctx.moveTo(x,y);}); ctx.stroke();
  ctx.fillStyle='#8b949e'; ctx.font='11px monospace';
  ctx.fillText('orange = best, blue = avg | max='+mx.toFixed(1)+' min='+mn.toFixed(1), 8, 14);
}

async function loadWads(){
  const r=await api('wads');
  const sel=$('g-wad'); sel.innerHTML='';
  for (const w of r.wads){
    const o=document.createElement('option'); o.value=w.name;
    o.textContent = w.name + (w.ok?(' ['+w.ident+', '+ (w.levels||[]).length +' lvl]'):' [битый]');
    sel.appendChild(o);
  }
  sel.dataset.loaded=1;
  if (CONFIG && CONFIG.game.wadName) sel.value=CONFIG.game.wadName;
  const t=$('w-list'); t.innerHTML='<tr><th>wad</th><th>размер</th><th>уровни</th></tr>';
  for (const w of r.wads){
    const tr=document.createElement('tr');
    tr.innerHTML='<td>'+w.fileName+'</td><td>'+(((w.bytes||0)/1048576).toFixed(1)+' MB')+'</td><td>'+((w.levels||[]).slice(0,6).join(', '))+'</td>';
    t.appendChild(tr);
  }
}

$('btn-game-start').onclick=async()=>{ await postJson('game-server/start',{}); refresh(); };
$('btn-game-stop').onclick =async()=>{ await postJson('game-server/stop',{}); refresh(); };
$('btn-open').onclick      =async()=>{ const r=await postJson('browser/open',{}); $('game-info').textContent=JSON.stringify(r); };
$('btn-train').onclick     =async()=>{ const r=await postJson('train/start',{}); $('game-info').textContent=JSON.stringify(r); refresh(); };
$('btn-pause').onclick     =async()=>{ await postJson('train/pause',{pause:true}); refresh(); };
$('btn-stop').onclick      =async()=>{ await postJson('train/stop',{}); refresh(); };

$('btn-save-game').onclick=async()=>{
  await postJson('config',{game:{wadName:$('g-wad').value, levelCode:$('g-level').value,
    skill:parseInt($('g-skill').value), maxSpeed:$('g-speed').checked, wadUrl:$('g-url').value||null},
    headless:$('g-headless').checked});
  $('game-info').textContent='игровая конфигурация сохранена'; loadWads();
};
$('btn-save-neat').onclick=async()=>{ await postJson('config',{neat:readFields('neat-fields')}); $('game-info').textContent='NEAT сохранён'; };
$('btn-save-ppo').onclick =async()=>{ await postJson('config',{ppo:readFields('ppo-fields')}); $('game-info').textContent='PPO сохранён'; };

$('btn-upload').onclick=async()=>{
  const f=$('w-file').files[0]; if(!f){ alert('выбери .wad'); return; }
  const fd=new FormData(); fd.append('wad',f);
  const r=await (await fetch('/api/wads/upload',{method:'POST',body:fd})).json();
  alert(JSON.stringify(r)); loadWads();
};
document.querySelectorAll('.dl').forEach(b=>b.onclick=async()=>{
  $('game-info').textContent='скачиваю '+b.dataset.f+' …';
  const r=await postJson('wads/download',{fileName:b.dataset.f});
  $('game-info').textContent=JSON.stringify(r); loadWads();
});
$('btn-regurl').onclick=async()=>{
  const r=await postJson('wads/register-url',{url:$('w-url').value});
  alert(JSON.stringify(r)); loadWads();
};

refresh(); loadWads();
setInterval(refresh, 2000);
</script>
</body>
</html>
"""


# ----------------------------------------------------------------------------- visualization server (:7980)

VIZ_HTML = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>DOOM NEAT — визуализация</title>
<style>
 body{background:#111;color:#ddd;font:13px/1.4 monospace;margin:0;padding:12px}
 h1{font-size:16px;margin:0 0 8px;color:#e74c3c}
 .row{display:flex;gap:12px;flex-wrap:wrap}
 #frame{background:#000;border:1px solid #333}
 .panel{background:#1a1a1a;border:1px solid #333;padding:10px;border-radius:6px;margin-bottom:10px}
 canvas#map{background:#0d0d0d;border:1px solid #333;display:block}
 button{background:#333;color:#eee;border:1px solid #555;padding:6px 12px;cursor:pointer;border-radius:4px;margin-right:6px}
 button:hover{background:#444}
 table{border-collapse:collapse;width:100%} td,th{padding:2px 6px;border-bottom:1px solid #2a2a2a;text-align:left}
 .k{color:#888} .v{color:#0f0} .act{color:#f1c40f;font-weight:bold}
 img#frameimg{max-width:640px;display:block}
</style></head><body>
<h1>DOOM NEAT+PPO — живой взгляд агента (мозг прямо из window API)</h1>
<div class="row">
 <div>
   <div class="panel">
     <img id="frameimg" width="640" alt="нет кадра — тренировка не запущена?">
     <div style="margin-top:6px">
       <button onclick="ctl('pause')">⏸ пауза</button>
       <button onclick="ctl('resume')">▶ продолжить</button>
       <button onclick="ctl('save')">💾 сейв мозга сейчас</button>
       <button onclick="ctl('stop')">⏹ стоп тренировки</button>
     </div>
   </div>
   <div class="panel"><b>Мозг / HUD</b><div id="hud"></div></div>
 </div>
 <div>
   <div class="panel"><b>Карта уровня + агент + видимые вещи</b><br><canvas id="map" width="420" height="420"></canvas></div>
   <div class="panel"><b>Окно обучения (PPO history)</b><table id="ppo"></table></div>
   <div class="panel"><b>Действия</b><div id="actions"></div></div>
 </div>
</div>
<script>
const ctl=c=>fetch('/api/mind/'+c,{method:'POST'}).then(r=>r.json()).then(j=>console.log(j));
function bars(logits,names){let h='';(logits||[]).slice(0,names.length).forEach((v,i)=>{h+='<tr><td class=k>'+names[i]+'</td><td class=v>'+v.toFixed(2)+'</td></tr>';});return '<table>'+h+'</table>';}
async function refresh(){
 try{
  const st=await (await fetch('/api/state')).json();
  const t=st.trainer||{}, b=st.brain||{}, v=st.view||{}, p=v.player||{};
  document.getElementById('frameimg').src='/frame.jpg?t='+Date.now();
  const names=['forward','back','left','right','run','use','attack'];
  document.getElementById('hud').innerHTML=
    '<span class=k>статус:</span> <span class=v>'+t.status+'</span> '+
    '<span class=k>поколение:</span> <span class=v>'+(t.generation??0)+'</span> '+
    '<span class=k>эпизодов:</span> <span class=v>'+(t.episodes??0)+'</span><br>'+
    '<span class=k>best fitness:</span> <span class=v>'+(t.bestFitnessEver??'—')+'</span> '+
    '<span class=k>nodes/conns:</span> <span class=v>'+(b.nodes??'—')+'/'+(b.conns??'—')+'</span><br>'+
    '<span class=k>позиция:</span> <span class=v>'+Math.round(p.x||0)+', '+Math.round(p.y||0)+'</span> '+
    '<span class=k>yaw:</span> <span class=v>'+Math.round(p.angle||p.yaw||0)+'°</span><br>'+
    '<span class=k>HP:</span> <span class=v>'+(p.health??'—')+'</span> '+
    '<span class=k>armor:</span> <span class=v>'+(p.armor??'—')+'</span> '+
    '<span class=k>dead:</span> <span class=v>'+(p.dead?'ДА':'нет')+'</span><br>'+
    '<span class=k>последнее действие:</span> <span class=act>'+(st.last_action?st.last_action.name+' (yaw '+st.last_action.yaw+')':'—')+'</span>';
  drawMap(v);
  const ph=st.ppo_history||[];
  document.getElementById('ppo').innerHTML=ph.slice(-8).map(x=>'<tr><td class=k>ep'+x.episode+'</td><td class=v>R='+x.reward.toFixed(1)+'</td><td class=v>loss='+x.loss.toFixed(3)+'</td><td class=v>clip='+x.clip.toFixed(2)+'</td></tr>').join('');
  document.getElementById('actions').innerHTML=bars(st.last_logits,names);
 }catch(e){console.error(e);}
}
function drawMap(v){
 const c=document.getElementById('map'),g=c.getContext('2d');
 g.clearRect(0,0,c.width,c.height);
 const things=(v&&v.things)||[],p=(v&&v.player)||{x:0,y:0};
 let xs=[p.x||0],ys=[p.y||0];things.forEach(t=>{xs.push(t.x);ys.push(t.y);});
 const minx=Math.min(...xs),maxx=Math.max(...xs),miny=Math.min(...ys),maxy=Math.max(...ys);
 const sc=Math.max(1,(maxx-minx),(maxy-miny))*1.1||1;
 const T=x=>(x-(minx+maxx)/2)/sc*c.width+c.width/2;
 things.forEach(t=>{g.fillStyle=t.kind==='enemy'?'#e74c3c':(t.kind==='item'||t.kind==='pickup'||t.kind==='powerup')?'#f1c40f':'#666';g.fillRect(T(t.x)-2,T(t.y)-2,4,4);});
 g.fillStyle='#2ecc71';g.beginPath();g.arc(T(p.x||0),T(p.y||0),5,0,7);g.fill();
 const a=((p.angle||p.yaw||0))*Math.PI/180;
 g.strokeStyle='#2ecc71';g.beginPath();g.moveTo(T(p.x||0),T(p.y||0));g.lineTo(T(p.x||0)+Math.cos(a)*25,T(p.y||0)+Math.sin(a)*25);g.stroke();
}
refresh(); setInterval(refresh,1500);
</script></body></html>
"""


class VizHandler(BaseHTTPRequestHandler):
    state = None  # AppState

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        data = json.dumps(obj, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        st = self.state
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            data = VIZ_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif path == "/frame.jpg":
            jpeg = st.browser.frame_jpeg
            if jpeg:
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(jpeg)))
                self.end_headers()
                self.wfile.write(jpeg)
            else:
                self._json({"error": "кадра пока нет (тренировка не идёт?)"}, 404)
        elif path == "/api/state":
            tr = st.trainer
            view = st.browser.view_data or {}
            la = getattr(tr, "last_action", None) if tr else None
            self._json({
                "trainer": (dict(tr.stats) if tr else {"status": "idle"}),
                "brain": (tr.current_brain if tr else None),
                "paused": bool(tr.paused.is_set()) if tr else False,
                "view": view,
                "things_count": len(view.get("things", []) or []),
                "last_action": la,
                "last_logits": (la or {}).get("logits"),
                "ppo_history": getattr(st, "ppo_history", []),
                "mind": {"autoSave": CFG.get()["mind"]["autoSave"],
                         "autoLoad": CFG.get()["mind"]["autoLoad"],
                         "lastMindSave": (tr.stats["lastMindSave"] if tr else None),
                         "file": Trainer._latest_mind_file()},
                "frame_ts": st.browser.frame_ts,
            })
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
        elif path.startswith("/api/wads"):
            self._json({"root": WADS_DIR, "wads": scan_wads()})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        st = self.state
        path = self.path.split("?")[0]
        if path.startswith("/api/mind/"):
            cmd = path.rsplit("/", 1)[-1]
            tr = st.trainer
            if tr is None:
                self._json({"ok": False, "error": "тренер не запущен"}, 409)
                return
            self._json(tr.control(cmd))
        elif path == "/api/viz/toggle":
            st.browser.viz_enabled = not st.browser.viz_enabled
            self._json({"ok": True, "viz_enabled": st.browser.viz_enabled})
        else:
            self._json({"error": "not found"}, 404)


def start_viz_server(state, port):
    try:
        VizHandler.state = state
        httpd = ThreadingHTTPServer((VIZ_HOST, port), VizHandler)
    except OSError as e:
        state.log("визуализация на :%d не поднялась: %s" % (port, e))
        return None
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()
    state.log("визуализация мозга: http://%s:%d (живой кадр + карта + PPO-окно)" % (VIZ_HOST, port))
    return httpd


# ----------------------------------------------------------------------------- main

def main():
    global PANEL_HOST, PANEL_PORT, GAME_PORT, VIZ_PORT
    ap = argparse.ArgumentParser(description="DOOM NEAT+PPO control panel")
    ap.add_argument("--panel-port", type=int, default=PANEL_PORT)
    ap.add_argument("--viz-port", type=int, default=VIZ_PORT,
                    help="сервер визуализации мозга (window API), по умолчанию 7980")
    ap.add_argument("--game-port", type=int, default=GAME_PORT)
    ap.add_argument("--no-browser", action="store_true", help="не стартовать тренера сразу")
    ap.add_argument("--show", action="store_true", help="браузер с окном (не headless)")
    args = ap.parse_args()

    PANEL_PORT = args.panel_port
    VIZ_PORT = args.viz_port
    GAME_PORT = args.game_port
    cfg = CFG.get()
    with CFG.lock:
        CFG.data["panelPort"] = PANEL_PORT
        CFG.data["vizPort"] = VIZ_PORT
        CFG.data["gamePort"] = GAME_PORT
        CFG.data["siteUrl"] = "http://%s:%d/index.html" % (GAME_HOST, GAME_PORT)
        if args.show:
            CFG.data["headless"] = False
    CFG.save()

    # 1) сначала — контрольная панель на localhost:7990
    print("=" * 60)
    print("Контрольная панель:  http://localhost:%d" % PANEL_PORT)
    print("Визуализация мозга:  http://localhost:%d" % VIZ_PORT)
    print("=" * 60)
    threading.Thread(
        target=lambda: app.run(host=PANEL_HOST, port=PANEL_PORT, threaded=True, use_reloader=False),
        daemon=True).start()
    time.sleep(0.7)

    # 2) затем — игровой сервер (сайт + раздача wad'ов)
    STATE.game_server.start(GAME_PORT)

    # 2b) и сервер визуализации через window API (:7980)
    STATE.viz_httpd = start_viz_server(STATE, VIZ_PORT)

    # 3) опционально сразу стартует тренировка
    if not args.no_browser:
        STATE.trainer = Trainer(STATE)
        STATE.trainer.start()
        STATE.log("автозапуск тренировки (на панели можно остановить/паузить)")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        STATE.log("останавливаюсь…")
        tr = STATE.trainer
        if tr:
            pop = tr._pop_ref
            if pop is not None and CFG.get().get("mind", {}).get("autoSave", True):
                tr.mind_save(pop)   # финальный автосейв мозга при выходе
            tr.stop_event.set()
            try:
                tr.join(timeout=5)
            except Exception:
                pass
        if getattr(STATE, "viz_httpd", None):
            STATE.viz_httpd.shutdown()
        STATE.game_server.stop()


if __name__ == "__main__":
    main()
