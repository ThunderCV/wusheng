// 自动化测试：node tools/simulate.js
// 用测试玩家跑很多局，检查规则流程和信息隔离（侦探的手机拿不到真相）。
const assert = require("assert");
const { act, view, rooms, CFG, CARDS } = require("../server.js");

const results = { good: 0, evil: 0 };
let games = 0, finals = 0;
const TILE = Object.fromEntries(CARDS.tiles.map(t => [t.key, t]));

function checkIsolation(r) {
  const g = r.game;
  for (const id of g.seat) {
    const v = view(r, id);
    const role = g.roles[id];
    const s = JSON.stringify(v);
    if (r.status !== "end") {
      assert(!("roles" in v) && !("killer" in v) && !("answer" in v) && !("accusations" in v), "未结束时公共视图泄露了真相");
      if (role === "detective") {
        assert(!v.my.answer && !v.my.killer && !v.my.accomplice && !v.my.offer, "侦探拿到了不该看的信息");
      }
      if (role === "killer") assert(!v.my.killer && !v.my.offer, "凶手拿到了法医的候选板");
      assert(!("picks" in v) && typeof v.picked === "number", "选牌阶段泄露了谁选完了");
      if (v.my.pick) assert.deepEqual(v.my.pick, g.picks[id], "拿到了别人的选牌");
      if (role !== "forensic") assert(!v.my.offer, "非法医看到了候选板");
      assert(!s.includes('"ok":'), "未结束时泄露了指认结果细节");
    }
  }
}

function humanStep(r, host, code) {
  const g = r.game;
  const P = x => act({ pid: host, room: code, ...x });
  const role = g.roles[host];
  if (r.status === "crime" && role !== "forensic" && !g.picks[host]) {
    const h = g.hands[host];
    P({ action: "crime", w: h.w[0], c: h.c[1] });
    assert.throws(() => P({ action: "crime", w: h.w[1], c: h.c[1] }), /已经选过/);
    return true;
  }
  if (r.status === "hint" && role === "forensic") {
    const marks = {};
    if (g.round === 1) {
      marks.cause = 0;
      // 先测错误：少选一块会报错
      assert.throws(() => P({ action: "hint", marks: { cause: 0, [g.offer[0]]: 1 } }), /正好标记/);
      for (const k of g.offer.slice(0, CFG.firstPick)) marks[k] = TILE[k].opts.length - 1;
      P({ action: "hint", marks });
    } else {
      assert.throws(() => P({ action: "hint", marks: { [g.offer[0]]: 0 }, retire: "cause" }), /撤/);
      marks[g.offer[0]] = 2;
      P({ action: "hint", marks, retire: g.tiles[g.tiles.length - 1].key });
    }
    return true;
  }
  if (r.status === "talk") {
    if (role !== "forensic" && !g.used.has(host) && Math.random() < 0.3) {
      // 侦探有时指认真凶（必赢），有时乱猜
      if (role === "detective" && Math.random() < 0.3) P({ action: "accuse", target: g.killer, w: g.answer.w, c: g.answer.c });
      else {
        const t = Object.keys(g.hands).find(x => x !== host);
        P({ action: "accuse", target: t, w: g.hands[t].w[0], c: g.hands[t].c[0] });
      }
      return true;
    }
    if (role === "forensic") { P({ action: "next", round: g.round }); return true; }
  }
  if (r.status === "final" && role !== "forensic" && !g.used.has(host) && !g.passed.has(host)) {
    if (Math.random() < 0.5) P({ action: "pass" });
    else {
      const t = Object.keys(g.hands).find(x => x !== host);
      P({ action: "accuse", target: t, w: g.hands[t].w[1], c: g.hands[t].c[1] });
    }
    return true;
  }
  return false;
}

for (let n = CFG.minPlayers; n <= CFG.maxPlayers; n++) for (let k = 0; k < 300; k++) {
  const host = "host" + n + "x" + k;
  const { code } = act({ action: "create", pid: host, name: "房主", bots: n - 1 });
  const r = rooms.get(code);
  if (k % 3 === 0) act({ action: "settings", pid: host, room: code, forensic: host });
  act({ action: "settings", pid: host, room: code, accomplice: k % 2 === 0 });
  act({ action: "start", pid: host, room: code });
  const g = r.game;

  // 身份配比
  const cnt = role => Object.values(g.roles).filter(x => x === role).length;
  assert.equal(cnt("forensic"), 1);
  assert.equal(cnt("killer"), 1);
  assert.equal(cnt("accomplice"), k % 2 === 0 && n >= CFG.accompliceMin ? 1 : 0);
  if (k % 3 === 0) assert.equal(g.roles[host], "forensic");
  assert(!g.hands[g.forensic], "法医不该有牌");
  const all = Object.values(g.hands).flatMap(h => [...h.w, ...h.c]);
  assert.equal(new Set(all).size, all.length, "发牌重复");

  // 非法操作
  if (g.roles[host] === "forensic") assert.throws(() => act({ action: "crime", pid: host, room: code, w: "x", c: "y" }), /法医不用选牌/);
  else assert.throws(() => act({ action: "crime", pid: host, room: code, w: "不存在", c: g.hands[host].c[0] }), /凶器/);

  let steps = 0;
  while (r.status !== "end") {
    if (++steps > 200) throw new Error("卡住了：" + r.status);
    checkIsolation(r);
    if (!humanStep(r, host, code)) act({ action: "botsAct", pid: host, room: code });
  }
  assert.deepEqual(g.answer, g.picks[g.killer], "真相不是凶手选的那两张");
  assert.equal(Object.keys(g.picks).length, n - 1, "有人没选牌就开始了");
  // 结束后的一致性
  if (g.winner === "evil" && g.round === CFG.rounds && g.reason.includes("最后指认")) {
    assert(g.seat.every(id => id === g.forensic || g.used.has(id) || g.passed.has(id)), "最后指认还有人没决定就结算了");
    finals++;
  }
  const v = view(r, host);
  assert(v.answer && v.roles && v.winner, "结束视图缺字段");
  assert(g.tiles.length === 1 + CFG.firstPick || g.round === 1, "勘查板数量不对");
  assert(g.tiles[0].key === "cause", "死因板被撤了");
  if (g.winner === "good") assert(g.accusations.some(a => a.ok && g.roles[a.by] === "detective"));
  else assert(!g.accusations.some(a => a.ok));
  assert(g.accusations.every(a => !a.ok || (a.target === g.killer && a.w === g.answer.w && a.c === g.answer.c)));
  results[g.winner]++;
  games++;
  rooms.delete(code);
}

// 帮凶、凶手指认真相也一定算失败
for (let k = 0; k < 50; k++) {
  const host = "hostEvil" + k;
  const { code } = act({ action: "create", pid: host, name: "房主", bots: 6 });
  const r = rooms.get(code);
  act({ action: "settings", pid: host, room: code, forensic: host, accomplice: true });
  act({ action: "start", pid: host, room: code });
  const g = r.game;
  act({ action: "botsAct", pid: host, room: code }); // 凶手选牌
  act({ action: "hint", pid: host, room: code, marks: { cause: 0, ...Object.fromEntries(g.offer.slice(0, CFG.firstPick).map(x => [x, 0])) } });
  assert.equal(r.status, "talk");
  for (const who of [g.accomplice, g.killer]) {
    const target = who === g.killer ? g.accomplice : g.killer;
    act({ action: "accuse", pid: host, room: code, as: who, target, w: g.hands[target].w[0], c: g.hands[target].c[0] });
  }
  // 帮凶直接报出真相
  assert.equal(g.winner, undefined);
  assert.throws(() => act({ action: "accuse", pid: host, room: code, as: g.accomplice, target: g.killer, w: g.answer.w, c: g.answer.c }), /用过/);
  assert.throws(() => act({ action: "accuse", pid: host, room: code, target: g.killer, w: g.answer.w, c: g.answer.c }), /法医没有徽章/);
  rooms.delete(code);
}
{
  const host = "hostEvil2";
  const { code } = act({ action: "create", pid: host, name: "房主", bots: 6 });
  const r = rooms.get(code);
  act({ action: "settings", pid: host, room: code, forensic: host, accomplice: true });
  act({ action: "start", pid: host, room: code });
  const g = r.game;
  act({ action: "botsAct", pid: host, room: code });
  act({ action: "hint", pid: host, room: code, marks: { cause: 0, ...Object.fromEntries(g.offer.slice(0, CFG.firstPick).map(x => [x, 0])) } });
  act({ action: "accuse", pid: host, room: code, as: g.accomplice, target: g.killer, w: g.answer.w, c: g.answer.c });
  assert.notEqual(g.winner, "good", "帮凶报出真相不该让侦探方赢");
  assert.equal(r.status, "talk");
  rooms.delete(code);
}

console.log(`跑完 ${games} 局（${CFG.minPlayers}–${CFG.maxPlayers} 人），侦探方赢 ${results.good}，凶手方赢 ${results.evil}。其中 ${finals} 局走到了最后指认。规则和信息隔离检查都通过。`);
