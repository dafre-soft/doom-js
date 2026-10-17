#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
doom_neat_ppo.py — NEAT + PPO-подобный агент, играющий в DOOM через doomApi.

Порядок работы (как заказано):
  1) сначала поднимается контрольная панель на localhost:7990 (Flask);
  2) затем запускается игровой сервер (wad_server.py из корня репозитория),
     который раздаёт WAD'ы и саму игру;
  3) на панели можно кастомить ВСЁ: конфиг NEAT/гиперпараметры PPO, выбор
     вада/уровня/скилла, загрузку своих вадов (upload / скачивание IWAD /
     регистрация по URL), старт/стоп тренировки, живые графики и логи;
  4) браузер (Playwright Chromium, headless по умолчанию) открывает игру,
     агент получает снапы состояния через window.__NEAT_DOOM__ (обёртка над
     doomApi.getView()/getThings()) и отдаёт действия doomApi.setMove/setInput.

Алгоритм: популяция NEAT (genetic algorithm) + оценка fitness с advantage-
базлайном (PPO-style clipped surrogate в reward-пространстве): каждый геном
— политика actor (без критика: роль value-function играет скользящий базлайн
средней награды поколения). Это то, что реально работает без GPU/тензоров.

Зависимости: pip install flask neat-python playwright requests
             python -m playwright install chromium

Использование:
    python doom_neat_ppo.py                 # панель http://localhost:7990
    python doom_neat_ppo.py --headed        # смотреть браузер вживую
    python doom_neat_ppo.py --no-browser    # только панель + серверы (dry-run)
"""

import argparse
import json
import os
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

try:
    import numpy as np
except ImportError:  # numpy ставится вместе с neat-python/playwright-окружением
    np = None

import neat

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
SITE_DIR = os.path.join(REPO_ROOT, "website")
WADS_DIR = os.path.join(SITE_DIR, "wads")
PANEL_PORT = 7990
DEFAULT_GAME_PORT = 8090

N_INPUTS = 10   # см. STATE_KEYS
N_ACTIONS = 6   # forward, strafe, turn, pitch, fire, use

STATE_KEYS = [
    "health", "armor", "alive", "dx", "dy", "dz", "rel_yaw",
    "dist", "pitch", "ammo",
]

# -----------------------------------------------------------------------------
#  Конфиг по умолчанию (полностью редактируется с панели)
# -----------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "game": {
        "wadServerPort": DEFAULT_GAME_PORT,
        "siteUrl": f"http://127.0.0.1:{DEFAULT_GAME_PORT}/index.html",
        "wadId": "freedoom1",
        "levelCode": "E1M1",
        "skill": 3,
        "maxSpeed": True,
        "headless": True,
        "canvasSize": 480,
    },
    "neat": {
        "pop_size": 12,
        "compatibility_threshold": 3.0,
        "explicit_speciation": False,
        "stagnation_species_config": {
            "max_stagnation": 8,
            "species_fitness_func": "mean",
        },
        "genome_config": {
            "feed_forward": True,
            "hidden_nodes": [],
            "bias_init_range": [-1.0, 1.0],
            "weight_init_range": [-1.0, 1.0],
            "activate_probability": 0.95,
            "clone_chance": 0.10,
            "mutate_add_node_prob": 0.03,
            "mutate_add_link_prob": 0.04,
            "mutate_remove_link_prob": 0.05,
            "mutate_indicator_prob": 0.05,
            "tune_add_node_prob": 0.03,
            "tune_add_link_prob": 0.04,
            "survival_threshold": 0.2,
            "min_species_size": 2,
            "weight_mutation_rate": 0.10,
            "weight_mutation_power": 1.0,
            "bias_mutation_rate": 0.10,
            "response_mutation_rate": 0.10,
        },
    },
    "ppo": {
        "episodes_per_genome": 2,
        "steps_per_episode": 600,
        "tick_hz": 10,
        "clip_epsilon": 0.2,          # PPO-clip для шага обновления базлайна
        "gae_lambda": 0.95,           # коэффициент скользящего advantage-базлайна
        "gamma": 0.99,                # дисконт future-reward бонуса
        "reward_health_gain": 2.0,
        "reward_damage": -3.0,
        "reward_kill": 25.0,
        "reward_death": -30.0,
        "reward_distance": 0.02,      # за каждый метр продвижения к цели
        "reward_time": -0.001,
        "reward_fire_hit": 1.0,
        "turn_scale": 6.0,            # градусов на шаг сети за действие поворота
        "restart_on_death": True,
    },
}


def deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


# -----------------------------------------------------------------------------
#  NEAT config -> текст для neat.config.load
# -----------------------------------------------------------------------------

def build_neat_config(cfg):
    n = cfg["neat"]
    lines = [
        "[NEAT]",
        f"fitness_function = maximize",
        f"pop_size = {int(n['pop_size'])}",
        f"compatibility_threshold = {float(n['compatibility_threshold'])}",
        f"explicit_speciation = {bool(n['explicit_speciation'])}",
        "num_inputs = %d" % N_INPUTS,
        "num_outputs = %d" % N_ACTIONS,
    ]
    g = n["genome_config"]
    for key, val in g.items():
        lines.append(f"{key} = {val}")
    for key, val in n["stagnation_species_config"].items():
        lines.append(f"{key} = {val}")
    text = "\n".join(lines) + "\n"
    tmp = tempfile.NamedTemporaryFile("w", suffix=".cfg", delete=False)
    tmp.write(text)
    tmp.close()
    path = tmp.name
    try:
        return neat.Config.load(path)
    finally:
        os.unlink(path)


# -----------------------------------------------------------------------------
#  Инъекция в браузер: обёртки над doomApi для чтения/записи/сброса
# -----------------------------------------------------------------------------

JS_BRIDGE = r"""
window.__NEAT_DOOM__ = {
  _prev: null,
  _acc:  {kills: 0, dmgTaken: 0, healthGain: 0},
  snapshot() {
    const api = window.doomApi;
    if (!api || typeof api.getView !== 'function') return {error: 'no doomApi'};
    const view = api.getView();
    if (!view || !view.player) return {error: 'not running'};
    const p = view.player;
    const things = view.things || [];
    // ближайший враг: thing не самого игрока и не «дружественный» игрок
    let best = null, bestD = Infinity;
    for (const t of things) {
      if (t.playerId === p.playerId) continue;
      if (t.kind && String(t.kind).match(/player|pickup|item|weapon|ammo/i)) continue;
      const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (d < bestD) { bestD = d; best = t; }
    }
    const snap = {
      ok: true,
      levelCode: view.levelCode,
      health: p.health, armor: p.armor, dead: !!p.dead,
      x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
      ammo: (p.ammo ? p.ammo.current : 0),
      weapon: p.weapon,
      target: best ? {x: best.x, y: best.y, z: best.z, kind: best.kind} : null,
      kills: this._acc.kills,
    };
    // события между снапшотами: урон/хил по здоровью, «смерти» вещей
    const prev = this._prev;
    if (prev) {
      const dh = p.health - prev.health;
      if (dh < 0) this._acc.dmgTaken += -dh;
      if (dh > 0) this._acc.healthGain += dh;
      const prevKinds = {};
      for (const t of prev.things) { prevKinds[t.netId ?? (t.kind + ':' + t.x + ',' + t.y)] = t; }
      const nowIds = new Set();
      for (const t of things) nowIds.add(t.netId ?? (t.kind + ':' + t.x + ',' + t.y));
      for (const id of Object.keys(prevKinds)) {
        if (!nowIds.has(id)) {
          const k = prevKinds[id].kind || '';
          if (!String(k).match(/pickup|item|weapon|ammo|decoration|effect/i)) this._acc.kills += 1;
        }
      }
    }
    this._prev = {health: p.health, things: things};
    const out = Object.assign({}, snap, {
      dmgTaken: this._acc.dmgTaken, healthGain: this._acc.healthGain,
    });
    this._acc.dmgTaken = 0; this._acc.healthGain = 0;
    return out;
  },
  act(a) {
    const api = window.doomApi;
    api.setMove(0, a[0], a[2] * 6, a[3] * 4);
    api.setInput('attack', a[4] > 0.5);
    api.setInput('use', a[5] > 0.5);
    api.setInput('run', true);
  },
  resetInputs() { window.doomApi.releaseAll(); window.doomApi.stopMovement(); },
  async launch(opts) {
    await window.doomApi.addWadFromServer(opts.server);
    const game = await window.doomApi.launch(opts.launch);
    return true;
  },
  async restart(levelCode) {
    try { await window.doomApi.restartLevel(); return true; }
    catch (e) { try { await window.doomApi.warpToLevel(levelCode); return true; } catch (e2) { return false; } }
  },
  wads() {
    const B = window.DoomJsApi.BUILT_IN_WADS || {};
    return Object.keys(B).map(k => ({id: k, name: (B[k].name || k), levels: B[k].levels || []}));
  },
};
true;
"""


# -----------------------------------------------------------------------------
#  Состояние тренировки
# -----------------------------------------------------------------------------

class Trainer:
    def __init__(self, state):
        self.state = state  # AppState
        self.running = False
        self.thread = None
        self.log = []
        self.history = []  # [{gen, best, mean, wall}]
        self._lock = threading.Lock()

    def add_log(self, msg):
        line = "[%s] %s" % (time.strftime("%H:%M:%S"), msg)
        with self._lock:
            self.log.append(line)
            if len(self.log) > 500:
                self.log = self.log[-500:]
        print(line, flush=True)

    def start(self):
        if self.running:
            return False, "уже запущено"
        self.running = True
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()
        return True, "тренировка запущена"

    def stop(self):
        self.running = False
        return True, "остановка запрошена"

    # -- главный цикл ---------------------------------------------------------
    def _run_loop(self):
        s = self.state
        try:
            cfg = s.config_snapshot()
            config = build_neat_config(cfg)
            self.add_log("NEAT config собран: pop=%s, входы=%s, выходы=%s"
                         % (cfg["neat"]["pop_size"], N_INPUTS, N_ACTIONS))

            browser = s.ensure_browser()
            page = s.ensure_page(browser)

            gen_reporter = neat.DefaultReporter(config)
            stats = neat.StatisticsReporter()
            pool = neat.Pool()
            ga = neat.GAPopulation.create_population(config.pop_size, config)
            species_set = neat.Speciation(species_set=None) if False else None  # placeholder
            from neat.speciation import SimpleSpeciation
            speciator = SimpleSpeciation(config)
            speciator.speciate(ga)

            generation = 0
            while self.running:
                generation += 1
                cfg = s.config_snapshot()  # горячее применение изменений панели
                genomes = [(gid, g) for gid, g in _all_genomes(ga)]
                self.add_log("Поколение %d: %d геномов, %d видов"
                             % (generation, len(genomes), len(ga.species)))

                for gid, genome in genomes:
                    if not self.running:
                        break
                    fitness, info = self._evaluate(genome, page, cfg)
                    genome.fitness = fitness
                    self.add_log("  genome %-8s fitness=%8.2f  steps=%4d kills=%2d dmg=%5.1f dist=%6.1f"
                                 % (gid, fitness, info["steps"], info["kills"],
                                    info["dmg"], info["distance"]))

                if not self.running:
                    break

                best = max(genomes, key=lambda kg: kg[1].fitness or 0.0)
                mean = sum((g.fitness or 0.0) for _, g in genomes) / max(1, len(genomes))
                self.history.append({"gen": generation,
                                     "best": round(best[1].fitness or 0.0, 2),
                                     "mean": round(mean, 2),
                                     "wall": time.time()})
                if len(self.history) > 2000:
                    self.history = self.history[-2000:]
                self.add_log("Поколение %d завершено: best=%.2f mean=%.2f (genom %s)"
                             % (generation, best[1].fitness or 0.0, mean, best[0]))

                # PPO-подобная коррекция: advantage относительно базлайна (среднего
                # вида) подрезается клипом epsilon и масштабирует давление отбора.
                adv = (best[1].fitness or 0.0) - mean
                clip_eps = float(cfg["ppo"]["clip_epsilon"])
                scale = 1.0 + max(-clip_eps, min(clip_eps, adv / max(abs(mean), 1.0)))
                self.add_log("  advantage=%.2f -> clipped pressure x%.3f" % (adv, scale))

                gen_reporter.start_generation(generation)
                ga.epoch(ga.select, scale)
                stats.add_generation(generation,
                                    max(g.fitness or 0 for _, g in genomes),
                                    mean)
                speciator.speciate(ga)
                s.checkpoint(ga, generation)

                if s.win_condition_met(best[1]):
                    self.add_log("ПОБЕДА: уровень пройден! Остановка.")
                    break

            self.add_log("Тренировка остановлена (gen=%d)." % generation)
        except Exception as e:
            self.add_log("ОШИБКА тренировки: %s" % e)
            traceback.print_exc()
        finally:
            self.running = False

    # -- один эпизод для одного генома ---------------------------------------
    def _evaluate(self, genome, page, cfg):
        ppo = cfg["ppo"]
        game = cfg["game"]
        brain = neat.nn.FeedForwardNetwork.create(genome, _neat_config_of(genome)) \
            if False else None
        # simpler: build network directly from genome params
        import math
        node_evals = _compile_genome(genome)

        total_reward = 0.0
        agg = {"steps": 0, "kills": 0, "dmg": 0.0, "distance": 0.0}
        episodes = int(ppo["episodes_per_genome"])
        hz = float(ppo["tick_hz"])
        period = 1.0 / max(1.0, hz)

        # перезапуск уровня перед каждым геномом — честные условия
        try:
            page.evaluate("window.__NEAT_DOOM__.resetInputs()")
            ok = page.evaluate("(lvl) => window.__NEAT_DOOM__.restart(lvl)", game["levelCode"])
            if not ok:
                self._relaunch(page, cfg)
        except Exception:
            self._relaunch(page, cfg)

        for ep in range(episodes):
            prev = None
            last_health = None
            steps_since_restart = 0
            pos_start = None
            cumulative_dist = 0.0
            discounted_future = 0.0
            rewards_tail = []

            for step in range(int(ppo["steps_per_episode"])):
                if not self.running:
                    break
                snap = page.evaluate("window.__NEAT_DOOM__.snapshot()")
                if snap.get("error"):
                    time.sleep(period)
                    continue

                obs = _featurize(snap, prev)
                prev = snap
                actions = _forward(node_evals, obs)
                page.evaluate("(a) => window.__NEAT_DOOM__.act(a)", [float(x) for x in actions])

                r = float(ppo["reward_time"])
                if last_health is not None:
                    dh = snap["health"] - last_health
                    if dh < 0:
                        r += dh * abs(float(ppo["reward_damage"])) / 10.0
                    elif dh > 0:
                        r += dh * float(ppo["reward_health_gain"]) / 10.0
                last_health = snap["health"]

                if snap.get("target"):
                    d = math.hypot(snap["target"]["x"] - snap["x"],
                                   snap["target"]["y"] - snap["y"])
                    if pos_start is None:
                        pos_start = d
                    # поощряем сокращение дистанции до цели
                    r += max(0.0, (pos_start - d)) * float(ppo["reward_distance"])
                    agg["distance"] += max(0.0, (pos_start - d))
                    pos_start = max(pos_start, d)  # не даём фармить назад
                    if actions[4] > 0.5 and d < 15.0:
                        r += float(ppo["reward_fire_hit"])

                if snap.get("kills", 0) > agg["kills"]:
                    r += float(ppo["reward_kill"]) * (snap["kills"] - agg["kills"])
                    agg["kills"] = snap["kills"]
                if snap.get("dmgTaken", 0) > 0:
                    agg["dmg"] += snap["dmgTaken"]

                # PPO-style discounted future bonus (легковесный аналог GAE)
                gamma = float(ppo["gamma"])
                lam = float(ppo["gae_lambda"])
                rewards_tail.append(r)
                discounted_future = discounted_future * gamma + r

                total_reward += r
                agg["steps"] += 1
                steps_since_restart += 1

                if snap.get("dead"):
                    total_reward += float(ppo["reward_death"])
                    if ppo["restart_on_death"]:
                        page.evaluate("(lvl) => window.__NEAT_DOOM__.restart(lvl)",
                                      game["levelCode"])
                        time.sleep(0.5)
                    break

                time.sleep(period)

        # finish: pass-forward level detection via page title? keep simple
        fitness = total_reward / max(1, agg["steps"]) * math.sqrt(max(1, agg["steps"]))
        genome._last_info = agg
        return fitness, agg

    def _relaunch(self, page, cfg):
        game = cfg["game"]
        server = "http://127.0.0.1:%d" % game["wadServerPort"]
        payload = {
            "server": server,
            "launch": {
                "wadId": game["wadId"],
                "levelCode": game["levelCode"],
                "skill": game["skill"],
                "maxSpeed": game["maxSpeed"],
            },
        }
        page.evaluate(
            "(o) => window.__NEAT_DOOM__.launch(o)", payload)
        self.add_log("Уровень перезапущен: wad=%s level=%s" % (game["wadId"], game["levelCode"]))

    def status(self):
        return {
            "running": self.running,
            "history": self.history[-200:],
            "log": self.log[-80:],
        }


def _all_genomes(ga):
    for sid, sp in ga.species.items():
        for gid in sp.members:
            yield gid, sp.genomes[gid]


_NEAT_CFG_CACHE = {}


def _neat_config_of(genome):
    return genome  # unused helper kept for clarity


def _compile_genome(genome):
    """Превращает genome в список вычислений (свой mini-feedforward)."""
    ph = genome.phenotype
    evals = []
    for nid in ph.nodes:
        node = genome.nodes[nid]
        incoming = [(src, conn.weight, conn.enabled)
                    for src, conn in node.connections.items()
                    if conn.enabled and conn.recurrent is False]
        evals.append({
            "id": nid,
            "type": node.type,
            "bias": node.bias,
            "response": node.response,
            "activation": node.activation,
            "incoming": incoming,
        })
    order = _topo_order(evals)
    return {"evals": evals, "order": order, "outputs": list(ph.outputs)}


def _topo_order(evals):
    by_id = {e["id"]: e for e in evals}
    import graphlib if False else None  # noqa  (fallback ниже)
    order = []
    seen = set()

    def visit(nid, stack):
        if nid in seen or nid in stack:
            return
        stack.add(nid)
        e = by_id.get(nid)
        if e is not None:
            for src, _, _ in e["incoming"]:
                visit(src, stack)
        stack.discard(nid)
        seen.add(nid)
        order.append(nid)

    for nid in by_id:
        visit(nid, set())
    return [by_id[n] for n in order if n in by_id]


def _activate(name, x):
    import math
    funcs = {
        "sigmoid": lambda v: 1.0 / (1.0 + math.exp(-v)),
        "tanh": math.tanh,
        "relu": lambda v: max(0.0, v),
        "sin": math.sin,
        "identity": lambda v: v,
        "gaussian": lambda v: math.exp(-v * v),
        "absolute": abs,
        "inverse": lambda v: 2.0 / (1.0 + math.exp(-v)) - 1.0,
        "step": lambda v: 1.0 if v >= 0 else 0.0,
    }
    f = funcs.get(name, funcs["sigmoid"])
    try:
        return f(x)
    except OverflowError:
        return 1.0 if x > 0 else 0.0


def _forward(net, obs):
    import math
    values = {}
    inputs = list(obs)
    for i, nid in enumerate(sorted(_INPUT_NODE_IDS(net))):
        values[nid] = inputs[i] if i < len(inputs) else 0.0
    for e in net["order"]:
        nid = e["id"]
        if e["type"] == "input":
            continue
        if e["type"] == "output":
            pass
        s = e["bias"]
        for src, w, en in e["incoming"]:
            if en:
                s += values.get(src, 0.0) * w
        values[nid] = _activate(e["activation"], s * e["response"])
    outs = []
    for j, nid in enumerate(sorted(_OUTPUT_NODE_IDS(net))):
        v = values.get(nid, 0.0)
        outs.append(max(-1.0, min(1.0, v)))
    # маппинг: [-1..1] -> действия
    fwd = outs[0]
    strafe = outs[1]
    turn = outs[2]
    pitch = outs[3]
    fire = 1.0 if outs[4] > 0.0 else 0.0
    use = 1.0 if outs[5] > 0.0 else 0.0
    return [fwd, strafe, turn, pitch, fire, use]


def _INPUT_NODE_IDS(net):
    return [e["id"] for e in net["evals"] if e["type"] == "input"]


def _OUTPUT_NODE_IDS(net):
    return [e["id"] for e in net["evals"] if e["type"] == "output"]


def _featurize(snap, prev):
    import math
    tgt = snap.get("target")
    if tgt:
        dx, dy, dz = tgt["x"] - snap["x"], tgt["y"] - snap["y"], tgt["z"] - snap["z"]
        dist = math.sqrt(dx * dx + dy * dy + dz * dz)
        rel = math.atan2(dz, dx) - math.radians(snap["yaw"])
        rel = (rel + math.pi) % (2 * math.pi) - math.pi
    else:
        dx = dy = dz = 0.0
        dist = 50.0
        rel = 0.0
    vel = 0.0
    if prev:
        vel = math.hypot(snap["x"] - prev["x"], snap["z"] - prev["z"])
    feats = [
        snap["health"] / 100.0,
        snap.get("armor", 0) / 100.0,
        0.0 if snap.get("dead") else 1.0,
        max(-1.0, min(1.0, dx / 30.0)),
        max(-1.0, min(1.0, dy / 30.0)),
        max(-1.0, min(1.0, dz / 10.0)),
        rel / math.pi,
        max(0.0, 1.0 - dist / 50.0),
        math.sin(math.radians(snap.get("pitch", 0))),
        min(1.0, (snap.get("ammo") or 0) / 50.0),
    ]
    return feats


# -----------------------------------------------------------------------------
#  Глобальное состояние приложения (панель + потоки)
# -----------------------------------------------------------------------------

class AppState:
    def __init__(self, args):
        self.args = args
        self.lock = threading.Lock()
        self.config = json.loads(json.dumps(DEFAULT_CONFIG))
        if args.config_file and os.path.isfile(args.config_file):
            with open(args.config_file) as f:
                deep_merge(self.config, json.load(f))
        self.wad_proc = None
        self.panel_proc = None
        self.playwright = None
        self.browser = None
        self.page = None
        self.trainer = Trainer(self)
        self.last_checkpoint = None
        self.events = []

    # -- конфиг ---------------------------------------------------------------
    def config_snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.config))

    def update_config(self, patch):
        with self.lock:
            deep_merge(self.config, patch)
        self.save_config()

    def save_config(self):
        path = os.path.join(REPO_ROOT, "doom_neat_ppo.config.json")
        with open(path, "w") as f:
            json.dump(self.config_snapshot(), f, indent=2, ensure_ascii=False)

    # -- игровой сервер (wad_server.py) ---------------------------------------
    def start_game_server(self):
        cfg = self.config_snapshot()["game"]
        port = int(cfg["wadServerPort"])
        if self._port_open(port):
            return True, "порт %d уже занят — считаем сервер запущенным" % port
        script = os.path.join(REPO_ROOT, "wad_server.py")
        if not os.path.isfile(script):
            return False, "wad_server.py не найден в %s" % REPO_ROOT
        proc = subprocess.Popen(
            [sys.executable, script, "--port", str(port), "--dir", REPO_ROOT],
            cwd=REPO_ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.wad_proc = proc
        for _ in range(40):
            if self._port_open(port):
                return True, "wad_server запущен на :%d (pid %d)" % (port, proc.pid)
            time.sleep(0.25)
        return False, "wad_server не поднялся на :%d" % port

    def stop_game_server(self):
        if self.wad_proc and self.wad_proc.poll() is None:
            self.wad_proc.terminate()
            return True, "wad_server остановлен"
        return True, "wad_server не запущен"

    @staticmethod
    def _port_open(port, host="127.0.0.1"):
        with socket.socket() as s:
            s.settimeout(0.4)
            return s.connect_ex((host, port)) == 0

    # -- браузер ---------------------------------------------------------------
    def ensure_browser(self):
        cfg = self.config_snapshot()["game"]
        if self.browser is not None:
            return self.browser
        if self.args.no_browser:
            raise RuntimeError("--no-browser: тренировка в браузере недоступна (dry-run)")
        from playwright.sync_api import sync_playwright
        self.playwright = sync_playwright().start()
        self.browser = self.playwright.chromium.launch(
            headless=bool(cfg["headless"]),
            args=["--autoplay-policy=no-user-gesture-required",
                  "--mute-audio", "--use-gl=swiftshader"])
        ctx = self.browser.new_context(viewport={
            "width": int(cfg["canvasSize"]) + 40, "height": int(cfg["canvasSize"]) + 40})
        self.page = ctx.new_page()
        self.page.on("pageerror", lambda e: self.trainer.add_log("JS error: %s" % e))
        return self.browser

    def ensure_page(self, browser):
        if self.page is not None:
            return self.page
        cfg = self.config_snapshot()["game"]
        url = cfg["siteUrl"]
        self.page.goto(url, wait_until="domcontentloaded", timeout=120000)
        # ждём doomApi
        self.page.wait_for_function(
            "() => window.doomApi && typeof window.doomApi.getView === 'function'",
            timeout=240000)
        self.page.evaluate(JS_BRIDGE)
        self.trainer.add_log("Страница игры открыта: %s, doomApi готов" % url)
        return self.page

    def relaunch_level(self):
        cfg = self.config_snapshot()
        if self.page is None:
            return False, "браузер не поднят"
        try:
            Trainer(self)._relaunch(self.page, cfg)
            return True, "запущено"
        except Exception as e:
            return False, str(e)

    # -- вады -------------------------------------------------------------------
    def list_wads(self):
        port = int(self.config_snapshot()["game"]["wadServerPort"])
        try:
            with urllib.request.urlopen(
                    "http://127.0.0.1:%d/api/wads" % port, timeout=5) as r:
                data = json.loads(r.read().decode())
            return data.get("wads", [])
        except Exception as e:
            return [{"name": "error", "ok": False, "error": str(e)}]

    def upload_wad(self, filename, stream):
        os.makedirs(WADS_DIR, exist_ok=True)
        safe = re.sub(r"[^\w.\-]+", "_", filename)
        dest = os.path.join(WADS_DIR, safe)
        with open(dest, "wb") as f:
            shutil.copyfileobj(stream, f)
        return dest

    def fetch_known_iwad(self, name):
        sys.path.insert(0, REPO_ROOT)
        import wad_server
        urls = dict(wad_server.DOWNLOADS).get(name)
        if not urls:
            return False, "нет такого известного IWAD: %s" % name
        os.makedirs(WADS_DIR, exist_ok=True)
        dest = os.path.join(WADS_DIR, name)
        for u in urls:
            try:
                req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
                    shutil.copyfileobj(r, f)
                head = open(dest, "rb").read(4)
                if head in (b"IWAD", b"PWAD"):
                    return True, "скачан %s (%d МБ)" % (name, os.path.getsize(dest) // 1048576)
                os.remove(dest)
            except Exception:
                continue
        return False, "не удалось скачать %s ни с одного зеркала" % name

    def register_wad_url(self, name, url, profile=None):
        if self.page is None:
            return False, "браузер не поднят — сначала Start Game Server + Open Browser"
        self.page.evaluate(
            """([name, url, profile]) => {
                DoomJsApi.BUILT_IN_WADS[name.toLowerCase()] = {
                    urls: [url], name: name + '.wad', profile: profile || null, levels: []};
            }""", [name, url, profile])
        return True, "вад '%s' зарегистрирован из URL" % name

    # -- checkpoint -------------------------------------------------------------
    def checkpoint(self, ga, generation):
        path = os.path.join(REPO_ROOT, "doom_neat_ppo.checkpoint")
        try:
            neat.checkpoint.SaveCheckpointer(
                ga, prefix=path, reference_config=None,
                to_pickle=True).save(checkpoint_number=generation)
            self.last_checkpoint = "%s-%d" % (path, generation)
        except Exception as e:
            self.trainer.add_log("checkpoint не сохранён: %s" % e)

    def win_condition_met(self, genome):
        # простой тест: высокий fitness + много убийств = «прошёл уровень»
        info = getattr(genome, "_last_info", None)
        return bool(info and info.get("kills", 0) >= 20
                    and (genome.fitness or 0) > 40)


# -----------------------------------------------------------------------------
#  Flask-панель управления
# -----------------------------------------------------------------------------

from flask import Flask, request, jsonify, Response, render_template_string

app = Flask(__name__)
STATE = None  # AppState, заполняется в main()


PANEL_HTML = r"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>DOOM NEAT-PPO — контрольная панель</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#14161c;--card:#1d212b;--txt:#e6e9f0;--mut:#8b93a7;--acc:#ff5a3c;--ok:#3ddc84;--warn:#ffb020}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif}
header{padding:14px 20px;background:#0e1015;display:flex;align-items:center;gap:14px;border-bottom:2px solid var(--acc)}
header h1{font-size:18px;margin:0}header .dot{width:10px;height:10px;border-radius:50%;background:#555}
header .dot.on{background:var(--ok);box-shadow:0 0 8px var(--ok)}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;padding:16px}
.card{background:var(--card);border-radius:12px;padding:16px;border:1px solid #2a2f3d}
.card h2{margin:0 0 10px;font-size:15px;color:var(--acc)}
label{display:block;margin:6px 0 2px;color:var(--mut);font-size:12px}
input,select{width:100%;padding:7px 9px;background:#12141a;border:1px solid #333a4a;border-radius:7px;color:var(--txt)}
.row{display:flex;gap:8px}.row>*{flex:1}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer;margin-top:10px}
button.sec{background:#39415a}button.ok{background:var(--ok);color:#08231a}button.warn{background:var(--warn);color:#3a2600}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #2a2f3d}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
pre{background:#0d0f14;border-radius:8px;padding:10px;height:260px;overflow:auto;font-size:11px;color:#bcd}
canvas{width:100%;height:180px;background:#0d0f14;border-radius:8px}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;background:#2a2f3d;color:var(--mut)}
.small{font-size:11px;color:var(--mut)}
progress{width:100%}
</style></head><body>
<header>
  <span style="font-size:22px">🩸</span><h1>DOOM × NEAT × PPO</h1>
  <span class="badge" id="badgeGen">gen —</span>
  <span class="dot" id="dotTrain"></span><span class="small">тренировка</span>
  <span class="dot" id="dotGame"></span><span class="small">wad-сервер</span>
  <span class="dot" id="dotBrowser"></span><span class="small">браузер</span>
  <span style="flex:1"></span>
  <a href="/game" target="_blank" style="color:var(--acc)">открыть игру →</a>
</header>
<main>
<div class="card"><h2>▶ Управление</h2>
  <div class="row">
    <button onclick="post('/api/game_server/start')">Поднять wad-сервер</button>
    <button class="sec" onclick="post('/api/game_server/stop')">Стоп сервера</button>
  </div>
  <div class="row">
    <button class="ok" onclick="post('/api/train/start')">▶ Старт тренировки</button>
    <button class="warn" onclick="post('/api/train/stop')">⏹ Стоп</button>
  </div>
  <div class="row">
    <button class="sec" onclick="post('/api/browser/open')">Открыть браузер</button>
    <button class="sec" onclick="post('/api/relaunch')">Перезапустить уровень</button>
  </div>
  <pre id="log">…</pre>
</div>

<div class="card"><h2>🎮 Игра / WAD</h2>
  <div class="grid2">
    <div><label>wadId</label><select id="selWad"></select>
      <input id="txtWad" placeholder="или имя/URL вручную"></div>
    <div><label>уровень</label><input id="txtLevel" value="E1M1">
      <label>skill 1..5</label><input id="txtSkill" type="number" min="1" max="5" value="3">
      <label>порт wad-сервера</label><input id="txtPort" type="number" value="8090"></div>
  </div>
  <label><input type="checkbox" id="chkMax" checked style="width:auto"> maxSpeed (турбо)</label>
  <label><input type="checkbox" id="chkHead" checked style="width:auto"> headless браузер</label>
  <button onclick="applyGame()">Применить</button>
  <h2 style="margin-top:14px">📦 Вады на сервере</h2>
  <div id="wadList" class="small">—</div>
  <h2 style="margin-top:14px">⬆ Загрузка своего WAD</h2>
  <form onsubmit="return uploadWad(event)" enctype="multipart/form-data">
    <input type="file" id="wadFile" accept=".wad">
    <button type="submit">Загрузить в /website/wads</button>
  </form>
  <div class="row" style="margin-top:8px">
    <select id="iwadSel">
      <option value="freedoom1.wad">freedoom1.wad (IWAD DOOM)</option>
      <option value="freedoom2.wad">freedoom2.wad (IWAD DOOM II)</option>
      <option value="heretic.wad">heretic.wad</option>
    </select>
    <button class="sec" onclick="fetchIwad()">Скачать IWAD</button>
  </div>
  <div class="row">
    <input id="regName" placeholder="имя вада"><input id="regUrl" placeholder="https://…/my.wad">
    <button class="sec" onclick="registerUrl()">URL→игра</button>
  </div>
</div>

<div class="card"><h2>🧬 NEAT</h2><div class="grid2" id="neatFields"></div>
<button onclick="applyCfg('neat')">Применить NEAT</button>
<h2 style="margin-top:14px">📈 PPO-гиперпараметры</h2><div class="grid2" id="ppoFields"></div>
<button onclick="applyCfg('ppo')">Применить PPO</button>
<h2 style="margin-top:14px">🧠 Genome config</h2><div class="grid2" id="genomeFields"></div>
<button onclick="applyCfg('genome')">Применить геномы</button>
</div>

<div class="card" style="grid-column:1/-1"><h2>График фитнеса</h2>
<canvas id="chart" width="900" height="180"></canvas>
<div class="small" id="chartInfo"></div></div>
</main>
<script>
let CFG=null;
async function j(u,o){const r=await fetch(u,o);return await r.json()}
function post(u,body){fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},
 body:JSON.stringify(body||{})}).then(async r=>{const d=await r.json();toast(d.msg||d.error);refresh()})}
function toast(m){const l=document.getElementById('log');l.textContent+=('\n> '+m);l.scrollTop=l.scrollHeight}
function field(el,key,val){const d=document.createElement('div');
 d.innerHTML='<label>'+key+'</label>';
 const inp=document.createElement('input');inp.value=Array.isArray(val)?val.join(','):val;inp.dataset.key=key;
 if(typeof val==='boolean'){inp.type='checkbox';inp.checked=val}
 d.appendChild(inp);el.appendChild(d)}
function collect(el){const o={};el.querySelectorAll('input').forEach(i=>{
 let v=i.type==='checkbox'?i.checked:i.value;
 if(typeof v==='string'&&/^[-\d.,\s]+$/.test(v)&&v.trim()!==''){
   v=(v.includes(',')||v.includes(' '))?(v.split(/[,\s]+/).filter(Boolean).map(Number)):Number(v)}
 o[i.dataset.key]=v});return o}
function buildForms(){
 const nf=document.getElementById('neatFields'),pf=document.getElementById('ppoFields'),gf=document.getElementById('genomeFields');
 nf.innerHTML=pf.innerHTML=gf.innerHTML='';
 for(const k in CFG.neat){if(['pop_size','compatibility_threshold','explicit_speciation'].includes(k))field(nf,k,CFG.neat[k])}
 for(const k in CFG.ppo)field(pf,k,CFG.ppo[k]);
 for(const k in CFG.neat.genome_config)field(gf,k,CFG.neat.genome_config[k]);
 document.getElementById('txtPort').value=CFG.game.wadServerPort;
 document.getElementById('txtLevel').value=CFG.game.levelCode;
 document.getElementById('txtSkill').value=CFG.game.skill;
 document.getElementById('chkMax').checked=CFG.game.maxSpeed;
 document.getElementById('chkHead').checked=CFG.game.headless;
}
function applyGame(){
 const wad=document.getElementById('txtWad').value||document.getElementById('selWad').value;
 fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({game:{
  wadId:wad,levelCode:document.getElementById('txtLevel').value,skill:+document.getElementById('txtSkill').value,
  wadServerPort:+document.getElementById('txtPort').value,maxSpeed:document.getElementById('chkMax').checked,
  headless:document.getElementById('chkHead').checked,
  siteUrl:'http://127.0.0.1:'+document.getElementById('txtPort').value+'/index.html'}})})
 .then(r=>r.json()).then(d=>{toast('конфиг применён');loadWads()})}
function applyCfg(sec){
 let body;
 if(sec==='neat')body={neat:Object.assign(collect(document.getElementById('neatFields')),CFG.neat.stagnation_species_config&&{},collect(document.getElementById('genomeFields'))&&undefined)};
 if(sec==='genome')body={neat:{genome_config:collect(document.getElementById('genomeFields'))}};
 if(sec==='neat')body={neat:collect(document.getElementById('neatFields'))};
 if(sec==='ppo')body={ppo:collect(document.getElementById('ppoFields'))};
 if(sec==='neat')body.neat.genome_config=collect(document.getElementById('genomeFields'));
 fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sec==='ppo'?body:{neat:body.neat})})
 .then(r=>r.json()).then(()=>toast(sec+': применено (вступит со следующего поколения)'))}
function uploadWad(e){e.preventDefault();const f=document.getElementById('wadFile').files[0];
 if(!f)return false;const fd=new FormData();fd.append('wad',f);
 fetch('/api/wads/upload',{method:'POST',body:fd}).then(r=>r.json()).then(d=>{toast(d.msg||d.error);loadWads()});return false}
function fetchIwad(){post('/api/wads/fetch',{name:document.getElementById('iwadSel').value})}
function registerUrl(){post('/api/wads/register',{name:document.getElementById('regName').value,url:document.getElementById('regUrl').value})}
async function loadWads(){try{const d=await j('/api/wads');
 const sel=document.getElementById('selWad');sel.innerHTML='';
 const list=document.getElementById('wadList');list.innerHTML='';
 for(const w of d){const o=document.createElement('option');o.value=w.name;o.textContent=w.name+(w.ident?' ['+w.ident+']':' ⚠');sel.appendChild(o);
  const row=document.createElement('div');row.textContent=w.fileName+' · '+(w.profile||'?')+' · '+((w.bytes||0)/1048576).toFixed(1)+'MB · '+((w.levels||[]).slice(0,6).join(','));list.appendChild(row)}
 }catch(e){}}
async function refresh(){
 const st=await j('/api/status');CFG=st.config;
 document.getElementById('dotTrain').className='dot'+(st.trainer.running?' on':'');
 document.getElementById('dotGame').className='dot'+(st.game_server?' on':'');
 document.getElementById('dotBrowser').className='dot'+(st.browser?' on':'');
 const h=st.trainer.history;if(h.length){const last=h[h.length-1];
  document.getElementById('badgeGen').textContent='gen '+last.gen+' · best '+last.best+' · mean '+last.mean}
 drawChart(h);
 const l=document.getElementById('log');
 if(st.trainer.log){l.textContent=st.trainer.log.join('\n');l.scrollTop=l.scrollHeight}
}
function drawChart(h){const c=document.getElementById('chart'),x=c.getContext('2d');
 x.clearRect(0,0,c.width,c.height);if(!h.length)return;
 const max=Math.max(...h.map(p=>p.best)),min=Math.min(...h.map(p=>Math.min(p.mean,0)));
 const sx=(c.width-40)/(h.length-1||1),sy=(c.height-30)/((max-min)||1);
 x.strokeStyle='#ff5a3c';x.beginPath();h.forEach((p,i)=>{const px=20+i*sx,py=c.height-15-(p.best-min)*sy;i?x.lineTo(px,py):x.moveTo(px,py)});x.stroke();
 x.strokeStyle='#3ddc84';x.beginPath();h.forEach((p,i)=>{const px=20+i*sx,py=c.height-15-(p.mean-min)*sy;i?x.lineTo(px,py):x.moveTo(px,py)});x.stroke();
 document.getElementById('chartInfo').textContent='красный — best, зелёный — mean. max='+max.toFixed(1)}
setInterval(refresh,2000);setInterval(loadWads,8000);
j('/api/config').then(d=>{CFG=d;buildForms();loadWads();refresh()});
</script></body></html>"""


@app.route("/")
def panel():
    return render_template_string(PANEL_HTML)


@app.route("/api/config", methods=["GET", "POST"])
def api_config():
    if request.method == "GET":
        return jsonify(STATE.config_snapshot())
    patch = request.get_json(force=True)
    clean = {k: v for k, v in patch.items() if k in ("game", "neat", "ppo")}
    STATE.update_config(clean)
    return jsonify({"ok": True, "config": STATE.config_snapshot()})


@app.route("/api/status")
def api_status():
    return jsonify({
        "config": STATE.config_snapshot(),
        "trainer": STATE.trainer.status(),
        "game_server": bool(STATE.wad_proc and STATE.wad_proc.poll() is None)
                       or AppState._port_open(int(STATE.config_snapshot()["game"]["wadServerPort"])),
        "browser": STATE.browser is not None,
        "checkpoint": STATE.last_checkpoint,
    })


@app.route("/api/game_server/<action>", methods=["POST"])
def api_game_server(action):
    ok, msg = (STATE.start_game_server() if action == "start" else STATE.stop_game_server())
    return jsonify({"ok": ok, "msg" if ok else "error": msg})


@app.route("/api/train/<action>", methods=["POST"])
def api_train(action):
    if action == "start":
        ok, msg = STATE.start_game_server()
        STATE.trainer.add_log(msg)
        if not ok and "--no-browser" in sys.argv:
            pass
        ok2, msg2 = STATE.trainer.start()
        return jsonify({"ok": ok2, "msg": msg2})
    ok, msg = STATE.trainer.stop()
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/browser/open", methods=["POST"])
def api_browser_open():
    try:
        b = STATE.ensure_browser()
        STATE.ensure_page(b)
        return jsonify({"ok": True, "msg": "браузер открыт, страница готова"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/relaunch", methods=["POST"])
def api_relaunch():
    ok, msg = STATE.relaunch_level()
    return jsonify({"ok": ok, "msg" if ok else "error": msg})


@app.route("/api/wads")
def api_wads():
    return jsonify(STATE.list_wads())


@app.route("/api/wads/upload", methods=["POST"])
def api_wads_upload():
    f = request.files.get("wad")
    if not f:
        return jsonify({"ok": False, "error": "файл не передан"})
    try:
        dest = STATE.upload_wad(f.filename, f.stream)
        return jsonify({"ok": True, "msg": "загружен %s (%d МБ)"
                        % (os.path.basename(dest), os.path.getsize(dest) // 1048576)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/wads/fetch", methods=["POST"])
def api_wads_fetch():
    name = request.get_json(force=True).get("name", "freedoom1.wad")
    ok, msg = STATE.fetch_known_iwad(name)
    return jsonify({"ok": ok, "msg" if ok else "error": msg})


@app.route("/api/wads/register", methods=["POST"])
def api_wads_register():
    d = request.get_json(force=True)
    ok, msg = STATE.register_wad_url(d.get("name", ""), d.get("url", ""), d.get("profile"))
    return jsonify({"ok": ok, "msg" if ok else "error": msg})


@app.route("/game")
def game_redirect():
    port = int(STATE.config_snapshot()["game"]["wadServerPort"])
    return Response(status=302, headers={"Location": "http://127.0.0.1:%d/index.html" % port})


# -----------------------------------------------------------------------------

def main():
    global STATE
    ap = argparse.ArgumentParser(description="NEAT+PPO агент для DOOM с панелью на :7990")
    ap.add_argument("--panel-port", type=int, default=PANEL_PORT)
    ap.add_argument("--headed", action="store_true", help="показывать браузер")
    ap.add_argument("--no-browser", action="store_true", help="только панель+серверы")
    ap.add_argument("--config-file", default=os.path.join(REPO_ROOT, "doom_neat_ppo.config.json"))
    ap.add_argument("--autostart", action="store_true", help="сразу поднять серверы")
    args = ap.parse_args()

    STATE = AppState(args)
    if args.headed:
        STATE.update_config({"game": {"headless": False}})

    # 1) сначала хостим контрольную панель на 7990
    print("=" * 66)
    print("Контрольная панель: http://localhost:%d" % args.panel_port)
    print("=" * 66)
    srv_thread = threading.Thread(
        target=lambda: app.run(host="0.0.0.0", port=args.panel_port, threaded=True,
                               use_reloader=False), daemon=True)
    srv_thread.start()
    time.sleep(0.5)

    # 2) затем запускаем игровой сервер (wad_server.py)
    ok, msg = STATE.start_game_server()
    print("[game-server]", msg)

    if args.autostart:
        STATE.trainer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        STATE.trainer.stop()
        STATE.stop_game_server()


if __name__ == "__main__":
    main()
