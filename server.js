// 无声证词 · 游戏服务器（无依赖，Node 18+）
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 6 * 3600e3;
const INDEX = path.join(__dirname, "public", "index.html");
const CODECH = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const CFG = require("./config.js");
const CARDS = require("./cards.js");
validateConfig(CFG, CARDS);
const MIN_P = CFG.minPlayers, MAX_P = CFG.maxPlayers;
const TILE = Object.fromEntries(CARDS.tiles.map(t => [t.key, t]));
const RANDOM_TILES = CARDS.tiles.filter(t => t.key !== "cause").map(t => t.key);

function validateConfig(c, k) {
  const bad = [];
  const need = (cond, msg) => { if (!cond) bad.push(msg); };
  const posInt = x => Number.isInteger(x) && x > 0;
  need(posInt(c.minPlayers) && c.minPlayers >= 4, "minPlayers 至少是 4（法医 + 凶手 + 2 名侦探）");
  need(posInt(c.maxPlayers) && c.maxPlayers >= c.minPlayers, "maxPlayers 不能小于 minPlayers");
  for (const r of ["forensic", "detective", "killer", "accomplice"]) need(c.roles?.[r]?.name, `roles.${r} 缺少 name`);
  for (const s of ["good", "evil"]) need(c.sides?.[s]?.name, `sides.${s} 缺少 name`);
  for (const x of ["handSize", "rounds", "firstPick", "firstOffer", "laterOffer", "accompliceMin"]) need(posInt(c[x]), `${x} 要是正整数`);
  need(c.firstOffer >= c.firstPick, "firstOffer 不能小于 firstPick");
  need(c.laterOffer >= 1, "laterOffer 至少是 1");
  const uniq = a => new Set(a).size === a.length;
  need(Array.isArray(k.weapons) && uniq(k.weapons), "cards.js 的 weapons 有重复");
  need(Array.isArray(k.clues) && uniq(k.clues), "cards.js 的 clues 有重复");
  need(k.weapons?.length >= c.maxPlayers * c.handSize, `凶器至少要 ${c.maxPlayers * c.handSize} 张`);
  need(k.clues?.length >= c.maxPlayers * c.handSize, `线索至少要 ${c.maxPlayers * c.handSize} 张`);
  const tiles = k.tiles || [];
  need(tiles.some(t => t.key === "cause"), "cards.js 里要有 key 为 cause 的死因板");
  need(uniq(tiles.map(t => t.key)), "勘查板 key 有重复");
  for (const t of tiles) need(t.name && Array.isArray(t.opts) && t.opts.length >= 2, `勘查板 ${t.key} 格式不对`);
  const randomCount = tiles.length - 1;
  need(randomCount >= c.firstOffer + (c.rounds - 1) * c.laterOffer, `随机勘查板不够：至少要 ${c.firstOffer + (c.rounds - 1) * c.laterOffer} 块（死因板除外）`);
  if (bad.length) {
    console.error("配置有误：\n- " + bad.join("\n- "));
    process.exit(1);
  }
}

const rid = n => Array.from({ length: n }, () => CODECH[crypto.randomInt(CODECH.length)]).join("");
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, n);
const evil = role => CFG.roles[role]?.side === "evil";
const pick1 = a => a[crypto.randomInt(a.length)];

/** @type {Map<string, any>} */
const rooms = new Map();
const sortedPlayers = r => [...r.players.values()].sort((a, b) => a.joinedAt - b.joinedAt);
class Err extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

// ---------- 视图：每台手机只拿到自己该看的 ----------
function view(r, vid) {
  const g = r.game;
  const v = {
    code: r.code, host: r.host, me: vid, status: r.status,
    players: sortedPlayers(r).map(p => ({ id: p.id, name: p.name, bot: !!p.bot })),
    settings: r.settings,
  };
  if (r.status === "lobby" || !g) return v;
  const done = r.status === "end";
  Object.assign(v, {
    seat: g.seat, forensic: g.forensic, round: g.round, rounds: CFG.rounds,
    hands: g.hands, tiles: g.tiles, retired: g.retired,
    gid: g.id, order: speakOrder(g), used: [...g.used], passed: [...g.passed], fails: g.fails,
    hasAccomplice: g.hasAccomplice,
  });
  if (g.seat.includes(vid)) {
    const role = g.roles[vid];
    const my = { role, side: CFG.roles[role].side };
    if (role !== "detective") my.answer = g.answer;
    if (role === "forensic" || role === "accomplice") my.killer = g.killer;
    if (role === "forensic" || role === "killer") my.accomplice = g.accomplice || null;
    if (role === "forensic" && r.status === "hint") my.offer = g.offer;
    const mine = g.accusations.find(a => a.by === vid);
    if (mine) my.accusation = { target: mine.target, w: mine.w, c: mine.c, round: mine.round };
    v.my = my;
  }
  if (done) Object.assign(v, {
    roles: g.roles, answer: g.answer, killer: g.killer, accomplice: g.accomplice,
    accusations: g.accusations, winner: g.winner, reason: g.reason, solver: g.solver || null,
  });
  return v;
}

function broadcast(r) {
  r.touched = Date.now();
  for (const c of r.clients) {
    try { c.res.write(`data: ${JSON.stringify(view(r, c.vid))}\n\n`); } catch (e) {}
  }
}

// 发言顺序：法医以外的人，每轮起点往后挪一位
function speakOrder(g) {
  const s = g.seat.filter(id => id !== g.forensic);
  const k = (g.start + g.round - 1) % s.length;
  return [...s.slice(k), ...s.slice(0, k)];
}

// ---------- 流程 ----------
function startGame(r) {
  const seat = sortedPlayers(r).map(p => p.id);
  const n = seat.length;
  if (n < MIN_P) throw new Err(`至少需要 ${MIN_P} 人。`);
  if (n > MAX_P) throw new Err(`最多 ${MAX_P} 人。`);
  const want = r.settings.forensic;
  const forensic = want && seat.includes(want) ? want : pick1(seat);
  const others = shuffle(seat.filter(id => id !== forensic));
  const hasAccomplice = !!r.settings.accomplice && n >= CFG.accompliceMin;
  const roles = { [forensic]: "forensic" };
  const killer = others[0];
  roles[killer] = "killer";
  const accomplice = hasAccomplice ? others[1] : null;
  if (accomplice) roles[accomplice] = "accomplice";
  for (const id of others) if (!roles[id]) roles[id] = "detective";

  const W = shuffle(CARDS.weapons), Cl = shuffle(CARDS.clues), H = CFG.handSize;
  const hands = {};
  seat.filter(id => id !== forensic).forEach((id, i) => {
    hands[id] = { w: W.slice(i * H, i * H + H), c: Cl.slice(i * H, i * H + H) };
  });

  r.game = {
    seat, roles, forensic, killer, accomplice, hasAccomplice, hands,
    answer: null, round: 1, start: crypto.randomInt(n - 1),
    deck: shuffle(RANDOM_TILES), offer: [], tiles: [], retired: [],
    id: rid(6), used: new Set(), passed: new Set(), accusations: [], fails: [],
  };
  r.status = "crime";
}

function dealOffer(g) {
  const k = g.round === 1 ? CFG.firstOffer : CFG.laterOffer;
  g.offer = g.deck.splice(0, k);
}

function finish(r, winner, reason) {
  const g = r.game;
  g.winner = winner; g.reason = reason;
  r.status = "end";
}

function setCrime(r, w, c) {
  const g = r.game, h = g.hands[g.killer];
  if (!h.w.includes(w)) throw new Err("请从你面前的凶器里选一张。");
  if (!h.c.includes(c)) throw new Err("请从你面前的线索里选一张。");
  g.answer = { w, c };
  dealOffer(g);
  r.status = "hint";
}

function validMark(key, idx) {
  return Number.isInteger(idx) && idx >= 0 && idx < TILE[key].opts.length;
}

// 第 1 轮：cause + firstPick 块；之后：offer 里标 1 块 + 撤下 1 块旧板
function submitHint(r, body) {
  const g = r.game;
  const marks = body.marks && typeof body.marks === "object" ? body.marks : {};
  const keys = Object.keys(marks);
  for (const k of keys) {
    if (!(k === "cause" ? g.round === 1 : g.offer.includes(k))) throw new Err("只能标记这一轮发给你的勘查板。");
    if (!validMark(k, marks[k])) throw new Err("标记的选项不对。");
  }
  const picked = keys.filter(k => k !== "cause");
  if (g.round === 1) {
    if (!keys.includes("cause")) throw new Err(`请先在「${TILE.cause.name}」上做标记。`);
    if (picked.length !== CFG.firstPick) throw new Err(`除死因外，请正好标记 ${CFG.firstPick} 块勘查板。`);
    g.tiles = [{ key: "cause", mark: marks.cause, round: 1 }, ...picked.map(k => ({ key: k, mark: marks[k], round: 1 }))];
  } else {
    if (picked.length !== 1) throw new Err("这一轮请在新板里正好标记 1 块。");
    const out = clean(body.retire, 40);
    const idx = g.tiles.findIndex(t => t.key === out && t.key !== "cause");
    if (idx < 0) throw new Err("请选一块旧板撤下（死因板不能撤）。");
    const [old] = g.tiles.splice(idx, 1);
    g.retired.push({ ...old, until: g.round });
    g.tiles.push({ key: picked[0], mark: marks[picked[0]], round: g.round });
  }
  g.offer = [];
  r.status = "talk";
}

// 还没用徽章、也没放弃的人（法医除外）
const holders = g => g.seat.filter(id => id !== g.forensic && !g.used.has(id) && !g.passed.has(id));

function nextRound(r) {
  const g = r.game;
  if (g.round >= CFG.rounds) {
    // 最后指认：手里还有徽章的人逐个决定指认或放弃，全部决定完才结算
    r.status = "final";
    return checkFinal(r);
  }
  g.round++;
  dealOffer(g);
  r.status = "hint";
}

function checkFinal(r) {
  if (r.status === "final" && holders(r.game).length === 0) {
    finish(r, "evil", "最后指认结束，没人说中真相，凶手逍遥法外。");
  }
}

function pass(r, by) {
  const g = r.game;
  if (by === g.forensic) throw new Err("法医没有徽章。");
  if (g.used.has(by) || g.passed.has(by)) throw new Err("你已经做过决定了。");
  g.passed.add(by);
  checkFinal(r);
}

function accuse(r, by, target, w, c) {
  const g = r.game;
  if (by === g.forensic) throw new Err("法医没有徽章。");
  if (g.used.has(by)) throw new Err("你的徽章已经用过了。");
  const h = g.hands[target];
  if (!h || target === by) throw new Err("请选一名其他玩家（法医除外）。");
  if (!h.w.includes(w) || !h.c.includes(c)) throw new Err("凶器和线索都要从这名玩家面前的牌里选。");
  g.used.add(by);
  const ok = g.roles[by] === "detective" && target === g.killer && w === g.answer.w && c === g.answer.c;
  g.accusations.push({ by, target, w, c, ok, round: g.round });
  if (ok) {
    g.solver = by;
    const nm = r.players.get(by)?.name || "某人";
    return finish(r, "good", `${nm} 指认正确，凶手落网。`);
  }
  g.fails.push({ by, round: g.round });
  const detectives = g.seat.filter(id => g.roles[id] === "detective");
  if (detectives.every(id => g.used.has(id))) {
    return finish(r, "evil", "所有侦探的徽章都用完了，没人指认出真相。");
  }
  checkFinal(r);
}

// ---------- 测试玩家 ----------
function botsAct(r) {
  const g = r.game;
  if (!g) throw new Err("游戏还没开始。");
  const bot = id => r.players.get(id)?.bot;
  switch (r.status) {
    case "crime": {
      if (!bot(g.killer)) throw new Err("凶手不是测试玩家，等凶手选牌。");
      const h = g.hands[g.killer];
      setCrime(r, pick1(h.w), pick1(h.c));
      break;
    }
    case "hint": {
      if (!bot(g.forensic)) throw new Err("法医不是测试玩家，等法医标记。");
      const rnd = k => crypto.randomInt(TILE[k].opts.length);
      const marks = {};
      if (g.round === 1) {
        marks.cause = rnd("cause");
        for (const k of shuffle(g.offer).slice(0, CFG.firstPick)) marks[k] = rnd(k);
        submitHint(r, { marks });
      } else {
        const k = pick1(g.offer);
        marks[k] = rnd(k);
        submitHint(r, { marks, retire: pick1(g.tiles.filter(t => t.key !== "cause")).key });
      }
      break;
    }
    case "talk": {
      for (const id of g.seat) {
        if (r.status !== "talk") break;
        if (!bot(id) || id === g.forensic || g.used.has(id) || Math.random() > 0.25) continue;
        const target = pick1(Object.keys(g.hands).filter(x => x !== id));
        accuse(r, id, target, pick1(g.hands[target].w), pick1(g.hands[target].c));
      }
      if (r.status === "talk" && bot(g.forensic)) nextRound(r);
      break;
    }
    case "final": {
      for (const id of holders(g)) {
        if (r.status !== "final") break;
        if (!bot(id)) continue;
        if (Math.random() < 0.4) {
          const target = pick1(Object.keys(g.hands).filter(x => x !== id));
          accuse(r, id, target, pick1(g.hands[target].w), pick1(g.hands[target].c));
        } else pass(r, id);
      }
      break;
    }
    default:
      throw new Err("当前阶段测试玩家没什么可做的。");
  }
}

function removePlayer(r, id) {
  const name = r.players.get(id)?.name || "某人";
  r.players.delete(id);
  const g = r.game;
  if (r.settings.forensic === id) r.settings.forensic = "";
  if (g && g.seat.includes(id) && r.status !== "lobby" && r.status !== "end") {
    finish(r, null, `${name} 离开了房间，本局中止。`);
  }
  if (r.host === id) {
    const next = sortedPlayers(r).find(p => !p.bot);
    if (!next) { rooms.delete(r.code); for (const c of r.clients) { try { c.res.end(); } catch (e) {} } return; }
    r.host = next.id;
  }
}
function addBot(r) {
  const used = new Set([...r.players.values()].map(p => p.name));
  const id = "bot" + rid(10);
  r.players.set(id, { id, name: CFG.botNames.find(n => !used.has(n)) || "测试" + rid(2), joinedAt: Date.now() + r.players.size, bot: true });
}

// ---------- 接口 ----------
function act(body) {
  const pid = clean(body.pid, 40);
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(pid)) throw new Err("身份无效，请刷新页面。");
  const a = body.action;

  if (a === "create") {
    const name = clean(body.name, 8);
    if (!name) throw new Err("请输入昵称。");
    let code;
    do { code = rid(4); } while (rooms.has(code));
    const r = { code, host: pid, touched: Date.now(), status: "lobby", players: new Map(), clients: new Set(), game: null, settings: { forensic: "", accomplice: true } };
    r.players.set(pid, { id: pid, name, joinedAt: Date.now() });
    const bots = Math.min(Math.max(+body.bots || 0, 0), MAX_P - 1);
    for (let i = 0; i < bots; i++) addBot(r);
    rooms.set(code, r);
    return { code };
  }

  const r = rooms.get(clean(body.room, 4).toUpperCase());
  if (!r) throw new Err("房间不存在。", 404);
  const isHost = pid === r.host;
  const g = r.game;
  const asId = clean(body.as, 40);
  const actor = asId && isHost && r.players.get(asId)?.bot ? asId : pid;
  const inSeat = () => { if (!g || !g.seat.includes(actor)) throw new Err("你不在本局游戏中。"); };
  const phase = s => { if (r.status !== s) throw new Err("现在不是这个阶段。"); };

  switch (a) {
    case "hello":
      if (!r.players.has(pid)) throw new Err("你不在这个房间里。", 404);
      return { code: r.code };
    case "join": {
      const name = clean(body.name, 8);
      if (!name) throw new Err("请输入昵称。");
      const p = r.players.get(pid);
      if (p) p.name = name;
      else {
        if (r.players.size >= MAX_P) throw new Err(`房间已满（最多 ${MAX_P} 人）。`);
        r.players.set(pid, { id: pid, name, joinedAt: Date.now() });
      }
      break;
    }
    case "leave":
      if (!r.players.has(pid)) return { ok: true };
      removePlayer(r, pid);
      break;
    case "addBot":
      if (!isHost) throw new Err("只有房主能加测试玩家。");
      if (r.players.size >= MAX_P) throw new Err(`最多 ${MAX_P} 人。`);
      addBot(r);
      break;
    case "settings":
      if (!isHost) throw new Err("只有房主能改设置。");
      if (r.status !== "lobby") throw new Err("开局后不能改设置。");
      if ("forensic" in body) {
        const f = clean(body.forensic, 40);
        if (f && !r.players.has(f)) throw new Err("这名玩家不在房间里。");
        r.settings.forensic = f;
      }
      if ("accomplice" in body) r.settings.accomplice = !!body.accomplice;
      break;
    case "start":
      if (!isHost) throw new Err("只有房主能开始游戏。");
      if (r.status !== "lobby" && r.status !== "end") throw new Err("游戏已经在进行中。");
      startGame(r);
      break;
    case "crime":
      phase("crime"); inSeat();
      if (actor !== g.killer) throw new Err("只有凶手能选凶器和线索。");
      setCrime(r, clean(body.w, 20), clean(body.c, 20));
      break;
    case "hint":
      phase("hint"); inSeat();
      if (actor !== g.forensic) throw new Err("只有法医能做标记。");
      submitHint(r, body);
      break;
    case "next":
      phase("talk"); inSeat();
      if (actor !== g.forensic) throw new Err("只有法医能结束这一轮讨论。");
      if (+body.round !== g.round) throw new Err("这一轮已经结束了。");
      nextRound(r);
      break;
    case "accuse":
      if (r.status !== "talk" && r.status !== "final") throw new Err("现在不能指认。");
      inSeat();
      if (r.status === "final" && g.passed.has(actor)) throw new Err("你已经放弃了指认。");
      accuse(r, actor, clean(body.target, 40), clean(body.w, 20), clean(body.c, 20));
      break;
    case "pass":
      phase("final"); inSeat();
      pass(r, actor);
      break;
    case "botsAct":
      if (!isHost) throw new Err("只有房主能操作。");
      botsAct(r);
      break;
    case "lobby":
      if (!isHost) throw new Err("只有房主能操作。");
      r.status = "lobby"; r.game = null;
      break;
    default:
      throw new Err("未知操作。");
  }
  broadcast(r);
  return { ok: true };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return fs.createReadStream(INDEX).pipe(res);
  }
  if (req.method === "GET" && url.pathname === "/config") {
    // 只发文字和勘查板，牌库本身不发（发出去的牌在 view 里）
    const { botNames, ...pub } = CFG;
    return send(res, 200, { ...pub, tiles: CARDS.tiles });
  }
  if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, rooms: rooms.size });
  if (req.method === "GET" && url.pathname === "/events") {
    const r = rooms.get((url.searchParams.get("room") || "").toUpperCase());
    const pid = url.searchParams.get("pid") || "";
    if (!r || !r.players.has(pid)) return send(res, 404, { error: "房间不存在或你不在房间里。" });
    const as = url.searchParams.get("as") || "";
    const vid = as && pid === r.host && r.players.get(as)?.bot ? as : pid;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 2000\n\n");
    const c = { res, vid };
    r.clients.add(c);
    res.write(`data: ${JSON.stringify(view(r, vid))}\n\n`);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => { clearInterval(ping); r.clients.delete(c); r.touched = Date.now(); });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api") {
    let buf = "";
    req.on("data", d => { buf += d; if (buf.length > 64e3) req.destroy(); });
    req.on("end", () => {
      try { send(res, 200, act(JSON.parse(buf || "{}"))); }
      catch (e) { send(res, e.status || 400, { error: e instanceof Err ? e.message : "请求出错了，请重试。" }); }
    });
    return;
  }
  send(res, 404, { error: "not found" });
});

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (!r.clients.size && now - r.touched > ROOM_TTL_MS) rooms.delete(code);
}, 10 * 60e3).unref();

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`${CFG.title} 已启动`);
    console.log(`  本机：      http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) console.log(`  同一 Wi-Fi：http://${i.address}:${PORT}`);
    }
  });
}
module.exports = { act, view, rooms, CFG, CARDS };
