// deploy-watcher.js — Robinhood Chain token watcher → Telegram (card-style alerts)
//
// Setup:
//   npm install ethers node-telegram-bot-api
//   Run:  TG_TOKEN=xxx TG_CHAT=-100xxxx node deploy-watcher.js
//
// Env switches:
//   HIDE_MEMES=false  -> also show meme-named tokens (default: true = memes hidden;
//                        only RWA / Utility / Unclassified tokens are posted)
//   RPC / EXPLORER / POLL_MS as before
//
const { ethers } = require("ethers");
// node-telegram-bot-api changed its export style in v1.x (June 2026):
// 0.x exports the class directly, 1.x exports { TelegramBot }. Accept both so
// a Railway rebuild that pulls a newer version can't crash the bot on boot.
const tgLib = require("node-telegram-bot-api");
const TelegramBot = tgLib.TelegramBot || tgLib.default || tgLib;
const fs = require("fs");

// ---------- config ----------
const RPC = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
const EXPLORER = process.env.EXPLORER || "https://robinhoodchain.blockscout.com";
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;
const POLL_MS = Number(process.env.POLL_MS || 2000);

if (!TG_TOKEN || !TG_CHAT) {
  console.error("Set TG_TOKEN and TG_CHAT env vars.");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC);
const bot = new TelegramBot(TG_TOKEN, { polling: false });

// ---------- meme filter ----------
// This channel is for RWA / utility launches. Tokens whose name/ticker clearly
// reads as a meme are fully hidden (no cards, no DexScreener watching). Tokens
// with no signal either way are "Unclassified" and STILL SHOWN — real projects
// often have neutral names (e.g. "Arrow"), so unknowns must never be hidden.
// Set HIDE_MEMES=false in Railway to show everything again.
const HIDE_MEMES = (process.env.HIDE_MEMES || "true") === "true";

// ---------- rug detection config + flag store ----------
// Alert when >RUG_PCT % of a tracked pool's base-side liquidity is removed,
// or when the token's own deployer removes ANY amount.
const RUG_PCT = Number(process.env.RUG_PCT || 10);
// Flags persist to this file. On Railway, attach a Volume mounted at /data and
// set FLAGS_FILE=/data/flags.json so the rug list survives redeploys.
const FLAGS_FILE = process.env.FLAGS_FILE || "./flags.json";

let flags = { deployers: {}, tokens: {}, codeHashes: {} };
try {
  flags = Object.assign(flags, JSON.parse(fs.readFileSync(FLAGS_FILE, "utf8")));
  console.log(
    `loaded flags: ${Object.keys(flags.deployers).length} deployers, ` +
    `${Object.keys(flags.tokens).length} tokens, ${Object.keys(flags.codeHashes).length} code hashes`
  );
} catch { /* no flags file yet — start clean */ }

function saveFlags() {
  try { fs.writeFileSync(FLAGS_FILE, JSON.stringify(flags, null, 2)); }
  catch (e) { console.error("flag save failed:", e.message); }
}

function addFlag(kind, key) {
  if (!key) return;
  const k = key.toLowerCase();
  flags[kind][k] = (flags[kind][k] || 0) + 1;
  saveFlags();
}

// ---------- ERC20 + pool ABIs ----------
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];
const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

// Base/quote tokens (WETH, USDC...) — the "other side" of a pair
const BASE_SYMBOLS = /^(weth|eth|usdc|usdt|dai|wbtc|rbh-eth)$/i;

// Meme words: matching one of these HIDES the token (when HIDE_MEMES is on),
// so short common substrings (cat/ape/cum/gme/wsb) are word-bounded to avoid
// hiding legit names like "Catalyst", "Grape", "Accumulate".
const MEME_WORDS = /(doge?|inu|shib|pepe|elon|moon|floki|wojak|chad|meme|baby|safe|\bcum\b|\bcats?\b|frog|bonk|wif|turbo|degen|rekt|\bapes?\b|pump|\bhood\b|\bgme\b|\bwsb\b|tendies|stonk)/i;
const UTILITY_WORDS = /(gov|dao|stake|vault|protocol|finance|swap|lend|oracle|bridge|usd|eth|wrapped|staked|reward|index|liquidity|yield|\bai\b)/i;
// RWA-flavoured words get their own label — Robinhood is pushing real-world assets
const RWA_WORDS = /(\brwa\b|real[\s-]?world|asset|tokeni[sz]|treasur|\bbonds?\b|estate|realt|propert|gold|silver|commodit|\bstocks?\b|equit|\betfs?\b|fund|credit|capital|invoice)/i;

// Returns "rwa" | "utility" | "meme" | "unknown".
// Checked in that order ON PURPOSE: a name that signals both ("Gold Doge") is
// shown rather than hidden — missing a real project is worse than letting the
// odd meme slip through. This is a name-based screen, not a verdict.
function classify(name, symbol) {
  const hay = `${name} ${symbol}`.toLowerCase();
  if (RWA_WORDS.test(hay)) return "rwa";
  if (UTILITY_WORDS.test(hay)) return "utility";
  if (MEME_WORDS.test(hay)) return "meme";
  return "unknown";
}

function clsLabel(cls) {
  return cls === "rwa" ? "RWA"
       : cls === "utility" ? "Utility"
       : cls === "meme" ? "Meme"
       : "Unclassified";
}

// hide rule: only confident memes are hidden, and only while HIDE_MEMES is on
function isHiddenToken(s) {
  return HIDE_MEMES && s?.cls === "meme";
}

// ---------- Blockscout verification check ----------
// Returns "verified" | "similar" | "none".
// "similar" = contract itself is NOT verified, but Blockscout found a verified
// contract with identical bytecode (source shown on explorer is borrowed).
async function verifyState(addr) {
  try {
    const res = await fetch(`${EXPLORER}/api/v2/smart-contracts/${addr}`);
    if (!res.ok) return "none";
    const j = await res.json();
    if (j.is_verified || j.is_fully_verified || j.is_partially_verified) return "verified";
    if (j.name || j.source_code) return "similar"; // bytecode match from Blockscout DB
    return "none";
  } catch {
    return "none";
  }
}

// ---------- ownership / renounce check ----------
// Standard Ownable tokens expose owner() (or BSC-style getOwner()).
// owner == zero/dead address => ownership renounced, deployer can't touch it.
const OWNABLE_ABI = [
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
];
const RENOUNCED_OWNERS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

async function ownershipState(addr) {
  const c = new ethers.Contract(addr, OWNABLE_ABI, provider);
  for (const fn of ["owner", "getOwner"]) {
    try {
      const o = (await c[fn]()).toLowerCase();
      return RENOUNCED_OWNERS.has(o)
        ? { state: "renounced", owner: null }
        : { state: "owned", owner: o };
    } catch { /* function doesn't exist — try the next one */ }
  }
  return { state: "unknown", owner: null }; // no standard owner() — can't tell
}

// ---------- buy/sell tax check (self-reported by the contract) ----------
// Standard tax-token templates expose their fees via public getters. We try the
// common naming families. IMPORTANT: these values are what the contract CLAIMS —
// a malicious custom contract can lie. Renounced = values frozen; owned = mutable.
const TAX_GETTER_PAIRS = [
  ["buyTax", "sellTax"],
  ["_buyTax", "_sellTax"],
  ["buyTotalFees", "sellTotalFees"],
  ["totalBuyTax", "totalSellTax"],
  ["buyFee", "sellFee"],
  ["buyFees", "sellFees"],
  ["taxBuy", "taxSell"],
];
const TAX_ABI = TAX_GETTER_PAIRS.flat().map(
  (n) => `function ${n}() view returns (uint256)`
);

function normTax(v) {
  let n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 100) n = n / 100; // looks like basis points (300 = 3%)
  if (n > 100) return 100;  // still absurd — cap for display
  return Math.round(n * 10) / 10;
}

async function taxState(addr) {
  const c = new ethers.Contract(addr, TAX_ABI, provider);
  for (const [b, sl] of TAX_GETTER_PAIRS) {
    try {
      const [bv, sv] = await Promise.all([c[b](), c[sl]()]);
      const buy = normTax(bv);
      const sell = normTax(sv);
      if (buy !== null && sell !== null) return { known: true, buy, sell };
    } catch { /* this naming family doesn't exist — try the next */ }
  }
  return { known: false, buy: null, sell: null };
}

async function readToken(addr) {
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  try {
    const [name, symbol, decimals, supply] = await Promise.all([
      c.name(), c.symbol(), c.decimals(), c.totalSupply(),
    ]);
    return { name, symbol, decimals, supply, isToken: true };
  } catch {
    return { isToken: false };
  }
}

// ---------- liquidity event topics ----------
const TOPICS = {
  V2_MINT: ethers.id("Mint(address,uint256,uint256)"),
  V2_BURN: ethers.id("Burn(address,uint256,uint256,address)"),
  V3_BURN: ethers.id("Burn(address,int24,int24,uint128,uint256,uint256)"),
  V3_MINT: ethers.id("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
  PAIR_CREATED: ethers.id("PairCreated(address,address,address,uint256)"),
  POOL_CREATED: ethers.id("PoolCreated(address,address,uint24,int24,address)"),
  TRANSFER: ethers.id("Transfer(address,address,uint256)"),
  OWNERSHIP_TRANSFERRED: ethers.id("OwnershipTransferred(address,address)"),
};

const DEAD_ADDRS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);
// Known LP-locker contracts on this chain. Empty right now — the old NOXA
// locker died with that platform (July 2026). Add locker addresses here as
// locking services appear on Robinhood Chain; "🔒 LOCKED" cards resume then.
const LOCKER_ADDRS = new Set([]);

function topicAddr(topic) {
  return "0x" + topic.slice(26).toLowerCase();
}

// ---------- telegram send (with retry) ----------
async function send(text, opts = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      return await bot.sendMessage(TG_CHAT, text, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        ...opts,
      });
    } catch (e) {
      if (i === 2) console.error("tg send failed:", e.message);
      else await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return null;
}

function fmtSupply(supply, decimals) {
  const human = Number(supply) / 10 ** Number(decimals || 18);
  return human.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// ---------- per-token status ----------
// addr(lower) -> everything we know about a token. The card is rebuilt from
// this on every event and sent as a FRESH message (edit-in-place was tried and
// deliberately removed — Telegram message ids live in RAM and die on redeploy).
const tokenStatus = new Map();

async function getStatus(addr, patch = {}) {
  const key = addr.toLowerCase();
  let s = tokenStatus.get(key);
  if (!s) {
    const info = await readToken(addr);
    s = {
      name: info.isToken ? info.name : "?",
      symbol: info.isToken ? info.symbol : "?",
      supplyStr: info.isToken ? fmtSupply(info.supply, info.decimals) : null,
      isToken: info.isToken,
      cls: info.isToken ? classify(info.name, info.symbol) : "unknown",
      deployer: null, pool: null,
      deployed: true, verify: "none", launching: false, lp: false,
      renounce: "unknown", ownerAddr: null,
      tax: { known: false, buy: null, sell: null },
      rugged: false, codeHash: null,
      // card state
      header: "🆕 *NEW TOKEN*",
      pairLabel: null, txHash: null, extraLines: [],
      dex: { live: false, url: null, links: [], liq: null, mc: null },
    };
    tokenStatus.set(key, s);
    // contract code is immutable: if tax getters don't exist now, they never will,
    // so the full getter scan runs exactly once per token
    if (s.isToken) {
      s.tax = await taxState(addr);
      try {
        s.codeHash = ethers.keccak256(await provider.getCode(addr)).toLowerCase();
      } catch { /* code fetch failed — no fingerprint */ }
    }
  }
  // re-check verification + ownership on every new stage — both often change
  // shortly after deploy (devs verify, then renounce)
  if (s.verify !== "verified") s.verify = await verifyState(addr);
  if (s.isToken && s.renounce !== "renounced") {
    const o = await ownershipState(addr);
    s.renounce = o.state;
    s.ownerAddr = o.owner;
  }
  // tax VALUES stay mutable while the owner holds the keys — refresh them
  if (s.isToken && s.tax.known && s.renounce !== "renounced") {
    s.tax = await taxState(addr);
  }
  Object.assign(s, patch);
  return s;
}

function statusChecklist(addr) {
  const s = tokenStatus.get(addr.toLowerCase()) || {};
  const d = s.dex || {};
  const row = (icon, n, title, sub) =>
    `${icon} *#${n} ${title}*\n     _${sub}_`;
  const [vIcon, vSub] =
    s.verify === "verified" ? ["✅", "Code human-readable on explorer"] :
    s.verify === "similar"  ? ["⚠️", "Unverified — bytecode matches a verified contract"] :
                              ["❌", "Source code not verified on explorer"];
  const dexSub = d.live
    ? ([d.liq ? `Liquidity ${d.liq}` : null, d.mc ? `MC ${d.mc}` : null]
        .filter(Boolean).join(" · ") || "Indexed and trading")
    : "Indexed on dexscreener.com";
  const [rIcon, rSub] =
    s.renounce === "renounced" ? ["✅", "Deployer can no longer modify the contract"] :
    s.renounce === "owned"     ? ["❌", `Owner can still modify: \`${(s.ownerAddr || "").slice(0, 10)}…\``] :
                                 ["⚠️", "No standard owner() — check contract manually"];
  return [
    row(s.deployed ? "✅" : "❌", 1, "CONTRACT DEPLOYED", "Smart contract on-chain"),
    row(vIcon, 2, "CONTRACT VERIFIED", vSub),
    row(s.launching ? "✅" : "❌", 3, "LAUNCHING", "Pair created — live or about to be"),
    row(s.lp ? "✅" : "❌", 4, "LIQUIDITY LOCKED / BURNED", "LP locked via third party or burned"),
    row(rIcon, 5, "OWNERSHIP RENOUNCED", rSub),
    row(d.live ? "✅" : "❌", 6, "LIVE ON DEXSCREENER", dexSub),
    row(d.links?.length ? "✅" : "❌", 7, "DEX INFO UPDATED", "Website & socials on DexScreener"),
  ].join("\n");
}

// ---------- the evolving card ----------
// Built entirely from tokenStatus, so it can be re-rendered after any change.
function buildCard(addr) {
  const key = addr.toLowerCase();
  const s = tokenStatus.get(key);
  if (!s) return null;
  const lines = [s.header, ""];
  // flag warnings — shown on every card of a matching token, right up top
  const warn = [];
  const dep = (s.deployer || "").toLowerCase();
  if (dep && flags.deployers[dep]) {
    warn.push(`\u26D4 *FLAGGED DEPLOYER* \u2014 pulled liquidity ${flags.deployers[dep]}\u00d7 before`);
  }
  if (flags.tokens[key] && !s.rugged) {
    warn.push(`\u26D4 *THIS TOKEN RUGGED BEFORE* \u2014 liquidity re-added`);
  }
  if (s.codeHash && flags.codeHashes[s.codeHash] && !s.rugged && !flags.tokens[key]) {
    warn.push(`\u26A0\uFE0F Code matches ${flags.codeHashes[s.codeHash]} prior rug(s) \u2014 may be a shared template`);
  }
  if (warn.length) lines.push(...warn, "");
  lines.push(`Name: *${s.name}*`);
  lines.push(`Ticker: *${s.symbol}*`);
  if (s.supplyStr) lines.push(`Supply: ${s.supplyStr}`);
  if (s.pairLabel) lines.push(`Pair: ${s.pairLabel}`);
  if (s.tax?.known) {
    const worst = Math.max(s.tax.buy, s.tax.sell);
    const mark = worst >= 30 ? " 🚨" : worst > 10 ? " ⚠️" : "";
    const frozen = s.renounce === "renounced" ? "" : " _(owner can change)_";
    lines.push(`Tax: Buy ${s.tax.buy}% / Sell ${s.tax.sell}%${mark}${frozen}`);
  } else if (s.isToken) {
    lines.push(`Tax: none declared`);
  }
  for (const ex of s.extraLines) lines.push(ex);
  lines.push("", statusChecklist(addr), "");
  if (s.dex.links.length) lines.push(`Links: ${s.dex.links.join(" · ")}`, "");
  lines.push(`CA: \`${addr}\``);
  if (s.deployer) lines.push(`Deployer: \`${s.deployer}\``);
  const links = [
    s.txHash ? `[Tx](${EXPLORER}/tx/${s.txHash})` : null,
    `[Contract](${EXPLORER}/address/${addr})`,
    `[Holders](${EXPLORER}/token/${addr}?tab=holders)`,
    s.dex.url ? `[DexScreener](${s.dex.url})` : null,
  ].filter(Boolean).join(" · ");
  lines.push(links);
  return lines.join("\n");
}

// post a fresh, complete card reflecting the token's CURRENT state.
// Every event sends a new card — the newest card is always the full picture.
async function sendCard(addr) {
  const text = buildCard(addr);
  if (text) await send(text);
}

// one alert per token per stage
const sentCards = new Set();
function once(stage, addr) {
  const k = `${stage}:${addr.toLowerCase()}`;
  if (sentCards.has(k)) return false;
  sentCards.add(k);
  return true;
}
// one launch per pool
const seenPools = new Set();

// ---------- pool helpers ----------
// Returns { mainAddr, pairLabel } for the non-base token in a pool, or null.
async function poolMainToken(poolAddr) {
  try {
    const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
    const [t0, t1] = await Promise.all([pool.token0(), pool.token1()]);
    const [a, b] = await Promise.all([readToken(t0), readToken(t1)]);
    let mainAddr, mainInfo, otherInfo;
    if (a.isToken && !BASE_SYMBOLS.test(a.symbol)) { mainAddr = t0; mainInfo = a; otherInfo = b; }
    else if (b.isToken && !BASE_SYMBOLS.test(b.symbol)) { mainAddr = t1; mainInfo = b; otherInfo = a; }
    else return null; // both base tokens or unreadable — not interesting
    const pairLabel = otherInfo.isToken
      ? `${mainInfo.symbol} / ${otherInfo.symbol}`
      : mainInfo.symbol;
    return { mainAddr, pairLabel };
  } catch {
    return null;
  }
}

// ---------- new-pool tracking ----------
// A pool only counts as NEW if we witnessed its creation event.
// This stops liquidity top-ups on OLD pools from firing fake "LAUNCHING" alerts.
const newPools = new Set();

function registerNewPool(log) {
  try {
    let poolAddr;
    if (log.topics[0] === TOPICS.PAIR_CREATED) {
      // PairCreated(token0, token1, pair, uint): pair = data word 0
      poolAddr = "0x" + log.data.slice(26, 66);
    } else {
      // PoolCreated(token0, token1, fee, tickSpacing, pool): pool = data word 1
      poolAddr = "0x" + log.data.slice(90, 130);
    }
    newPools.add(poolAddr.toLowerCase());
  } catch { /* malformed log — ignore */ }
}

// ---------- notifiers ----------

// Direct contract deployment (someone deploys their own token)
async function notifyDeploy(tx, receipt) {
  const addr = receipt.contractAddress;

  const s = await getStatus(addr, { deployer: tx.from, deployed: true, txHash: tx.hash });
  if (!s.isToken) return;       // not an ERC20 — skip
  if (isHiddenToken(s)) return; // meme-named — tracked internally, never carded
  if (!once("deploy", addr)) return;

  s.header = `🆕 *NEW TOKEN* (${clsLabel(s.cls)})`;
  await sendCard(addr);
  watchOnDexScreener(addr);
}

// First liquidity / new pool for a token
async function notifyLiquidity(log) {
  const poolKey = log.address.toLowerCase();
  // old pool (created before we were watching) getting topped up — not a launch
  if (!newPools.has(poolKey)) return;

  const launchKey = `launch:${poolKey}`;
  if (seenPools.has(launchKey)) return;

  const m = await poolMainToken(log.address);
  if (!m) { seenPools.add(launchKey); return; } // unreadable pool — skip silently

  seenPools.add(launchKey);
  const s = await getStatus(m.mainAddr, {
    launching: true,
    pool: log.address,
    pairLabel: m.pairLabel,
  });
  if (!s.txHash) s.txHash = log.transactionHash;
  if (isHiddenToken(s)) return; // meme-named — no launch card
  if (!once("launching", m.mainAddr)) return;

  s.header = `🚀 *LAUNCHING* (${clsLabel(s.cls)})`;
  await sendCard(m.mainAddr);
  watchOnDexScreener(m.mainAddr);
}

// LP tokens sent to dead address (burn) or a known locker (lock)
async function notifyBurnLock(log, kind) {
  const key = log.address.toLowerCase();
  // only for pools born under our watch — old tokens burning LP isn't our launch feed
  if (!newPools.has(key)) return;
  if (seenPools.has(`${kind}:${key}`)) return;

  // 0-amount dust transfers skip
  try {
    if (BigInt(log.data) === 0n) return;
  } catch { /* continue */ }

  const m = await poolMainToken(log.address);
  if (!m) return; // not an LP token — normal token burn, ignore

  seenPools.add(`${kind}:${key}`);
  const s = await getStatus(m.mainAddr, {
    lp: true,
    launching: true,
    pairLabel: m.pairLabel,
  });
  if (isHiddenToken(s)) return; // meme-named — no card
  if (!once(`lp:${kind}`, m.mainAddr)) return;

  const lpLine = `LP token: \`${log.address}\``;
  if (!s.extraLines.includes(lpLine)) s.extraLines.push(lpLine);

  const emoji = kind === "burnt" ? "🔥" : "🔒";
  s.header = `${emoji} *LIQUIDITY ${kind === "burnt" ? "BURNED" : "LOCKED"}* — *${s.symbol}*`;
  await sendCard(m.mainAddr);
  watchOnDexScreener(m.mainAddr);
}

// Ownership renounced: OwnershipTransferred(oldOwner -> zero/dead) on a tracked token
async function notifyRenounce(log) {
  const token = log.address.toLowerCase();
  const s = tokenStatus.get(token);
  if (!s || !s.isToken) return;   // only tokens we've tracked — keeps it launch-focused
  if (isHiddenToken(s)) return;   // meme-named — no card
  if (!once("renounced", token)) return;

  s.renounce = "renounced";
  s.ownerAddr = null;
  s.header = `🔑 *OWNERSHIP RENOUNCED* — *${s.symbol}*`;
  await sendCard(log.address);
}

// Liquidity REMOVED from a tracked pool (pool "Burn" event = LP withdrawal).
// Alerts when the token's deployer removes any amount, or anyone removes >RUG_PCT%.
function dataWord(data, i) {
  try { return BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64)); }
  catch { return 0n; }
}

async function notifyLiqRemoval(log, ver) {
  const poolKey = log.address.toLowerCase();
  if (!newPools.has(poolKey)) return;           // only pools born under our watch
  const m = await poolMainToken(log.address);
  if (!m) return;

  // amounts: V2 Burn data = [amount0, amount1]; V3 Burn data = [liquidity, amount0, amount1]
  const amt0 = ver === "v2" ? dataWord(log.data, 0) : dataWord(log.data, 1);
  const amt1 = ver === "v2" ? dataWord(log.data, 1) : dataWord(log.data, 2);
  if (amt0 === 0n && amt1 === 0n) return;       // V3 "poke" / dust — ignore

  // which side is the base (WETH/USDC) — measure removal on that side
  let baseAddr, baseRemoved;
  try {
    const pool = new ethers.Contract(log.address, POOL_ABI, provider);
    const [t0, t1] = await Promise.all([pool.token0(), pool.token1()]);
    const mainIs0 = t0.toLowerCase() === m.mainAddr.toLowerCase();
    baseAddr = mainIs0 ? t1 : t0;
    baseRemoved = mainIs0 ? amt1 : amt0;
  } catch { return; }
  if (baseRemoved === 0n) return;

  let pct = 100;
  try {
    const base = new ethers.Contract(baseAddr, ERC20_ABI, provider);
    const remaining = await base.balanceOf(log.address);
    pct = Number((baseRemoved * 10000n) / (baseRemoved + remaining)) / 100;
  } catch { /* balance read failed — treat as full removal */ }

  const tx = await provider.getTransaction(log.transactionHash).catch(() => null);
  const remover = tx?.from ? tx.from.toLowerCase() : null;

  const s = await getStatus(m.mainAddr, { pairLabel: m.pairLabel });
  const byDeployer = Boolean(remover && s.deployer && remover === s.deployer.toLowerCase());

  // trigger rules: deployer removing anything, or anyone crossing the threshold
  if (!byDeployer && pct < RUG_PCT) return;
  if (!once(`rug:${poolKey}`, m.mainAddr)) return;

  const isRug = pct >= RUG_PCT;
  if (isRug) {
    s.rugged = true;
    s.lp = false;
    // record the rugger even for hidden meme tokens — the deployer blacklist
    // protects future (utility) launches from the same wallet
    addFlag("deployers", remover);
    addFlag("tokens", m.mainAddr);
    addFlag("codeHashes", s.codeHash);
  }
  if (isHiddenToken(s)) return; // meme-named — flags recorded above, no card posted

  const pctStr = pct >= 99.9 ? "~100" : pct.toFixed(1);
  const who = remover
    ? `Removed by: \`${remover}\`${byDeployer ? " \u2014 *THE DEPLOYER*" : ""}`
    : "Remover unknown";
  const line = `\u203C\uFE0F ${pctStr}% of liquidity removed (${ver.toUpperCase()})`;
  if (!s.extraLines.includes(line)) s.extraLines.push(line, who);

  s.header = isRug
    ? `\u{1F6A8} *RUG PULL \u2014 LIQUIDITY REMOVED* \u2014 *${s.symbol}*`
    : `\u26A0\uFE0F *DEPLOYER REMOVED LIQUIDITY* \u2014 *${s.symbol}*`;
  await sendCard(m.mainAddr);
}

// ---------- DexScreener watcher ----------
// Every token we card gets watched on DexScreener for DEX_WATCH_HOURS.
// Sends: "LIVE ON DEXSCREENER" the first time it appears there, and
// "DEXSCREENER UPDATED" when its profile links (website/X/Telegram) appear or change.
const DEX_CHAIN_ID = process.env.DEX_CHAIN_ID || "robinhood";
const DEX_POLL_MS = Number(process.env.DEX_POLL_MS || 60000);   // poll once a minute
const DEX_WATCH_HOURS = Number(process.env.DEX_WATCH_HOURS || 24);
const DEX_WATCH_MAX = 300; // cap = 10 batched API calls/min max, well under rate limits

// token(lower) -> { addedAt, live, socialsKey }
const dexWatch = new Map();

function watchOnDexScreener(addr) {
  const key = addr.toLowerCase();
  if (dexWatch.has(key) || dexWatch.size >= DEX_WATCH_MAX) return;
  dexWatch.set(key, { addedAt: Date.now(), live: false, socialsKey: "" });
}

function linkLabel(type) {
  const t = (type || "").toLowerCase();
  if (t === "twitter" || t === "x") return "𝕏 Twitter";
  if (t === "telegram") return "✈️ Telegram";
  if (t === "discord") return "💬 Discord";
  if (t.includes("website") || t === "") return "🌐 Website";
  return `🔗 ${type[0].toUpperCase() + type.slice(1)}`;
}

function fmtUsd(n) {
  return "$" + Math.round(n).toLocaleString("en-US");
}

async function pollDexScreener() {
  // drop tokens past the watch window
  const cutoff = Date.now() - DEX_WATCH_HOURS * 3600 * 1000;
  for (const [k, v] of dexWatch) if (v.addedAt < cutoff) dexWatch.delete(k);
  if (dexWatch.size === 0) return;

  const addrs = [...dexWatch.keys()];
  for (let i = 0; i < addrs.length; i += 30) {
    const batch = addrs.slice(i, i + 30);
    let pairs = [];
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`
      );
      if (!res.ok) continue;
      const j = await res.json();
      pairs = j.pairs || [];
    } catch (e) {
      console.error("dexscreener poll error:", e.message);
      continue;
    }

    // keep each watched token's best (highest-liquidity) pair on our chain
    const best = new Map();
    for (const p of pairs) {
      if (p.chainId !== DEX_CHAIN_ID) continue;
      const base = p.baseToken?.address?.toLowerCase();
      if (!base || !dexWatch.has(base)) continue;
      const cur = best.get(base);
      if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) best.set(base, p);
    }

    for (const [token, p] of best) {
      const w = dexWatch.get(token);
      const s = tokenStatus.get(token);
      if (!s) continue; // watched tokens always have status, but be safe
      const dsUrl = p.url || `https://dexscreener.com/${DEX_CHAIN_ID}/${p.pairAddress}`;

      // (1) first time this token shows up on DexScreener → flip #6 on its card
      if (!w.live) {
        w.live = true;
        s.launching = true; // also backfills launches missed during downtime
        s.dex.live = true;
        s.dex.url = dsUrl;
        s.dex.liq = p.liquidity?.usd ? fmtUsd(p.liquidity.usd) : null;
        s.dex.mc = p.fdv ? fmtUsd(p.fdv) : null;
        if (!s.pairLabel && p.quoteToken?.symbol) {
          s.pairLabel = `${p.baseToken.symbol} / ${p.quoteToken.symbol}`;
        }
        s.header = `📈 *LIVE ON DEXSCREENER* — *${s.symbol}*`;
        await sendCard(token);
      }

      // (2) profile links appeared or changed (usually = dev paid for token info)
      //     → flip #7 on the card, show links on the card, ping with the links
      const links = [];
      for (const ws of p.info?.websites || []) {
        if (ws?.url) links.push(`[${linkLabel(ws.label || "website")}](${ws.url})`);
      }
      for (const so of p.info?.socials || []) {
        if (so?.url) links.push(`[${linkLabel(so.type)}](${so.url})`);
      }
      const keyNow = links.slice().sort().join("|");
      if (keyNow && keyNow !== w.socialsKey) {
        const first = !w.socialsKey;
        w.socialsKey = keyNow;
        s.dex.links = links;
        s.dex.url = dsUrl;
        s.header = `📣 *DEXSCREENER ${first ? "UPDATED" : "LINKS CHANGED"}* 🔥 — *${s.symbol}*`;
        await sendCard(token);
      }
    }
  }
}

// ---------- range scanner ----------
// Robinhood Chain has ~100ms blocks (up to ~10/sec). Scanning block-by-block
// with multiple RPC calls each can't keep up and gets rate-limited. Instead we
// scan RANGES of blocks with a handful of RPC calls per range.
const LOG_CHUNK = Number(process.env.LOG_CHUNK || 200);     // blocks per getLogs range
const BLOCK_CHUNK = Number(process.env.BLOCK_CHUNK || 20);  // blocks fetched in parallel
const MAX_LAG = Number(process.env.MAX_LAG || 2000);        // if further behind, skip ahead

// server-side filter: only Transfer events TO dead/locker addresses
const BURN_LOCK_TO_TOPICS = [...DEAD_ADDRS, ...LOCKER_ADDRS].map(
  (a) => ethers.zeroPadValue(a, 32)
);
// server-side filter: only OwnershipTransferred TO zero/dead (= renounce)
const RENOUNCE_TO_TOPICS = [...RENOUNCED_OWNERS].map(
  (a) => ethers.zeroPadValue(a, 32)
);

async function scanRange(from, to) {
  // A) direct contract deployments — blocks fetched in parallel batches
  for (let n = from; n <= to; n += BLOCK_CHUNK) {
    const end = Math.min(n + BLOCK_CHUNK - 1, to);
    const blocks = await Promise.all(
      Array.from({ length: end - n + 1 }, (_, i) =>
        provider.getBlock(n + i, true).catch(() => null)
      )
    );
    for (const block of blocks) {
      if (!block) continue;
      for (const tx of block.prefetchedTransactions) {
        if (tx.to === null) {
          const receipt = await provider.getTransactionReceipt(tx.hash).catch(() => null);
          if (receipt?.contractAddress && receipt.status === 1) {
            await notifyDeploy(tx, receipt);
          }
        }
      }
    }
  }

  // B) pool creations + liquidity adds for the whole range (one call)
  const liqLogs = await provider.getLogs({
    fromBlock: from,
    toBlock: to,
    topics: [[TOPICS.V2_MINT, TOPICS.V3_MINT, TOPICS.PAIR_CREATED, TOPICS.POOL_CREATED, TOPICS.V2_BURN, TOPICS.V3_BURN]],
  });
  for (const log of liqLogs) {
    const t = log.topics[0];
    if (t === TOPICS.PAIR_CREATED || t === TOPICS.POOL_CREATED) {
      // birth certificate: remember this pool as genuinely new (no alert yet)
      registerNewPool(log);
    } else if (t === TOPICS.V2_BURN || t === TOPICS.V3_BURN) {
      // liquidity REMOVED — rug detection
      await notifyLiqRemoval(log, t === TOPICS.V2_BURN ? "v2" : "v3");
    } else {
      // liquidity added: alert only if the pool was born under our watch
      await notifyLiquidity(log);
    }
  }

  // C) LP burns/locks: ONLY transfers to dead/locker addresses (filtered by
  //    the RPC node itself — the general Transfer firehose never reaches us)
  const blLogs = await provider.getLogs({
    fromBlock: from,
    toBlock: to,
    topics: [TOPICS.TRANSFER, null, BURN_LOCK_TO_TOPICS],
  });
  for (const log of blLogs) {
    if (log.topics.length !== 3) continue;
    const dest = topicAddr(log.topics[2]);
    if (DEAD_ADDRS.has(dest)) await notifyBurnLock(log, "burnt");
    else if (LOCKER_ADDRS.has(dest)) await notifyBurnLock(log, "locked");
  }

  // D) ownership renounces: OwnershipTransferred(old -> zero/dead), filtered
  //    server-side so only actual renounces reach us
  const renLogs = await provider.getLogs({
    fromBlock: from,
    toBlock: to,
    topics: [TOPICS.OWNERSHIP_TRANSFERRED, null, RENOUNCE_TO_TOPICS],
  });
  for (const log of renLogs) await notifyRenounce(log);
}

// ---------- main loop ----------
async function main() {
  let last = await provider.getBlockNumber();
  console.log(`Watching ${RPC} from block ${last}`);
  console.log(`Meme filter: ${HIDE_MEMES ? "ON (showing RWA / Utility / Unclassified only)" : "OFF (showing everything)"}`);
  await send(`✅ Robinhood Chain watcher online. Starting at block ${last}. Meme tokens: ${HIDE_MEMES ? "hidden — showing RWA / Utility / Unclassified only" : "shown"}.`);

  // DexScreener watcher — runs independently of the block scanner
  setInterval(
    () => pollDexScreener().catch((e) => console.error("dex poll error:", e.message)),
    DEX_POLL_MS
  );

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const head = await provider.getBlockNumber();
      if (head > last) {
        let from = last + 1;
        // safety valve: if we've fallen absurdly far behind (RPC outage etc.),
        // skip ahead instead of grinding through a hopeless backlog forever
        if (head - from > MAX_LAG) {
          console.warn(`lagging ${head - from} blocks — skipping ahead to stay live`);
          from = head - MAX_LAG;
        }
        while (from <= head) {
          const to = Math.min(from + LOG_CHUNK - 1, head);
          await scanRange(from, to);
          last = to; // commit progress per chunk — an error resumes HERE, not from scratch
          from = to + 1;
        }
      }
    } catch (e) {
      console.error("poll error:", e.message);
    } finally {
      busy = false;
    }
  }, POLL_MS);
}

main();
