// deploy-watcher.js — Robinhood Chain token watcher → Telegram (card-style alerts)
//
// Setup:
//   npm install ethers node-telegram-bot-api
//   Run:  TG_TOKEN=xxx TG_CHAT=-100xxxx node deploy-watcher.js
//
// Env switches:
//   EXCLUDE_NOXA=false  -> show NOXA Fun launch cards (default: true = NOXA fully hidden)
//   RPC / EXPLORER / POLL_MS as before
//
const { ethers } = require("ethers");
const TelegramBot = require("node-telegram-bot-api");

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

// ---------- NOXA Fun launchpad ----------
// Official NOXA Launch Factory on Robinhood Chain (chain id 4663)
// Source: https://docs.noxa.fi/contracts/noxa-fun/
const NOXA_FACTORY = (
  process.env.NOXA_FACTORY || "0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB"
).toLowerCase();

// Toggle: default true = NOXA fully hidden (it has its own platform).
// Set EXCLUDE_NOXA=false in Railway if you ever want NOXA launch cards back.
const EXCLUDE_NOXA = (process.env.EXCLUDE_NOXA || "true") === "true";

// Factory event emitted on every NOXA launch
// Source: https://docs.noxa.fi/integrations/launchpad/
const NOXA_IFACE = new ethers.Interface([
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)",
]);
const TOKEN_LAUNCHED_TOPIC = NOXA_IFACE.getEvent("TokenLaunched").topicHash;

// Legacy treasury heuristic (fallback for direct deploys touching NOXA)
const NOXA_TREASURY = "0x71f2f1c2dc94cdabfe29cb355119f8683ae0969b";

// NOXA token/pool addresses we've seen (suppress duplicate generic alerts)
const noxaAddrs = new Set();

function isNoxaTx(receipt) {
  for (const log of receipt.logs || []) {
    const a = log.address?.toLowerCase();
    if (a === NOXA_TREASURY || a === NOXA_FACTORY) return true;
    for (const topic of log.topics || []) {
      const t = "0x" + topic.slice(26).toLowerCase();
      if (t === NOXA_TREASURY || t === NOXA_FACTORY) return true;
    }
  }
  return false;
}

// ---------- ERC20 + pool ABIs ----------
const ERC20_ABI = [
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

const MEME_WORDS = /(doge?|inu|shib|pepe|elon|moon|floki|wojak|chad|meme|baby|safe|cum|cat|frog|bonk|wif|turbo|degen|rekt|ape|pump|\bhood\b|gme|wsb|tendies|stonk)/i;
const UTILITY_WORDS = /(gov|dao|stake|vault|protocol|finance|swap|lend|oracle|bridge|usd|eth|wrapped|staked|reward|index|liquidity|yield)/i;

function classify(name, symbol) {
  const hay = `${name} ${symbol}`.toLowerCase();
  if (UTILITY_WORDS.test(hay)) return "utility";
  if (MEME_WORDS.test(hay)) return "meme";
  return "meme?";
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
  V3_MINT: ethers.id("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
  PAIR_CREATED: ethers.id("PairCreated(address,address,address,uint256)"),
  POOL_CREATED: ethers.id("PoolCreated(address,address,uint24,int24,address)"),
  TRANSFER: ethers.id("Transfer(address,address,uint256)"),
};

const DEAD_ADDRS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);
const LOCKER_ADDRS = new Set([
  "0x7f03effbd7ceb22a3f80dd468f67ef27826acd85", // NOXA Launch Locker (Robinhood Chain)
]);

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

// ---------- per-token status (one evolving card per token) ----------
// addr(lower) -> everything we know about a token, including its Telegram
// card message id so later events EDIT the same card instead of new messages.
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
      deployer: null, pool: null, noxa: false,
      deployed: true, verify: "none", launching: false, lp: false,
      // card state
      header: "🆕 *NEW TOKEN*",
      pairLabel: null, txHash: null, extraLines: [],
      dex: { live: false, url: null, links: [], liq: null, mc: null },
    };
    tokenStatus.set(key, s);
  }
  // re-check verification on every new stage — devs often verify shortly after deploy
  if (s.verify !== "verified") s.verify = await verifyState(addr);
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
                              ["❌", "Code human-readable on explorer"];
  const dexSub = d.live
    ? ([d.liq ? `Liquidity ${d.liq}` : null, d.mc ? `MC ${d.mc}` : null]
        .filter(Boolean).join(" · ") || "Indexed and trading")
    : "Indexed on dexscreener.com";
  return [
    row(s.deployed ? "✅" : "❌", 1, "CONTRACT DEPLOYED", "Smart contract on-chain"),
    row(vIcon, 2, "CONTRACT VERIFIED", vSub),
    row(s.launching ? "✅" : "❌", 3, "LAUNCHING", "Pair created — live or about to be"),
    row(s.lp ? "✅" : "❌", 4, "LIQUIDITY LOCKED / BURNED", "LP locked via third party or burned"),
    row(d.live ? "✅" : "❌", 5, "LIVE ON DEXSCREENER", dexSub),
    row(d.links?.length ? "✅" : "❌", 6, "DEX INFO UPDATED", "Website & socials on DexScreener"),
  ].join("\n");
}

// ---------- the evolving card ----------
// Built entirely from tokenStatus, so it can be re-rendered after any change.
function buildCard(addr) {
  const s = tokenStatus.get(addr.toLowerCase());
  if (!s) return null;
  const lines = [s.header, ""];
  lines.push(`Name: *${s.name}*`);
  lines.push(`Ticker: *${s.symbol}*`);
  if (s.supplyStr) lines.push(`Supply: ${s.supplyStr}`);
  if (s.pairLabel) lines.push(`Pair: ${s.pairLabel}`);
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
    s.noxa ? `[Trade](https://fun.noxa.fi/robinhood)` : null,
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

function poolIsNoxa(poolAddr, mainAddr) {
  return noxaAddrs.has(poolAddr.toLowerCase()) ||
         (mainAddr && noxaAddrs.has(mainAddr.toLowerCase()));
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

// NOXA Fun launch (factory event) — token + pool + locked LP, all in one tx
async function notifyNoxaLaunch(log) {
  let ev;
  try {
    ev = NOXA_IFACE.parseLog({ topics: log.topics, data: log.data });
  } catch (e) {
    console.error("noxa decode failed:", e.message);
    return;
  }
  const token = ev.args.token;
  const pool = ev.args.pool;

  // always register, even when muted, so generic alerts stay quiet about noxa
  noxaAddrs.add(token.toLowerCase());
  noxaAddrs.add(pool.toLowerCase());
  seenPools.add(`launch:${pool.toLowerCase()}`);

  if (EXCLUDE_NOXA) return;
  if (!once("noxa", token)) return;

  // NOXA tokens: deployed + instantly trading on V3 + LP locked forever in locker
  const s = await getStatus(token, {
    deployer: ev.args.deployer,
    pool,
    deployed: true,
    launching: true,
    lp: true,
    noxa: true,
    txHash: log.transactionHash,
  });

  try {
    const pairInfo = await readToken(ev.args.pairToken);
    if (pairInfo.isToken) s.pairLabel = `${s.symbol} / ${pairInfo.symbol}`;
  } catch { /* koi baat nahi */ }

  const buyLine = `Initial buy: ${ethers.formatEther(ev.args.initialBuyAmount)} ETH`;
  if (!s.extraLines.includes(buyLine)) s.extraLines.push(buyLine);
  s.header = `🟢 *NOXA FUN LAUNCH* (${classify(s.name, s.symbol)})`;
  await sendCard(token);
}

// Direct contract deployment (someone deploys their own token)
async function notifyDeploy(tx, receipt) {
  const addr = receipt.contractAddress;

  // rare: direct deploy that touches noxa infra
  if (isNoxaTx(receipt)) {
    noxaAddrs.add(addr.toLowerCase());
    if (EXCLUDE_NOXA) return;
  }

  const s = await getStatus(addr, { deployer: tx.from, deployed: true, txHash: tx.hash });
  if (!s.isToken) return; // not an ERC20 — skip
  if (!once("deploy", addr)) return;

  s.header = `🆕 *NEW TOKEN* (${classify(s.name, s.symbol)})`;
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

  if (poolIsNoxa(log.address, m.mainAddr)) { seenPools.add(launchKey); return; }

  seenPools.add(launchKey);
  const s = await getStatus(m.mainAddr, {
    launching: true,
    pool: log.address,
    pairLabel: m.pairLabel,
  });
  if (!s.txHash) s.txHash = log.transactionHash;
  if (!once("launching", m.mainAddr)) return;

  s.header = `🚀 *LAUNCHING* (${classify(s.name, s.symbol)})`;
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
  if (poolIsNoxa(log.address, m.mainAddr)) return;

  seenPools.add(`${kind}:${key}`);
  const s = await getStatus(m.mainAddr, {
    lp: true,
    launching: true,
    pairLabel: m.pairLabel,
  });
  if (!once(`lp:${kind}`, m.mainAddr)) return;

  const lpLine = `LP token: \`${log.address}\``;
  if (!s.extraLines.includes(lpLine)) s.extraLines.push(lpLine);

  const emoji = kind === "burnt" ? "🔥" : "🔒";
  s.header = `${emoji} *LIQUIDITY ${kind === "burnt" ? "BURNED" : "LOCKED"}* — *${s.symbol}*`;
  await sendCard(m.mainAddr);
  watchOnDexScreener(m.mainAddr);
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

      // (1) first time this token shows up on DexScreener → flip #5 on its card
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
      //     → flip #6 on the card, show links on the card, ping with the links
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

async function scanRange(from, to) {
  // A) NOXA launches — registers noxa pools before liquidity scanning
  try {
    const noxaLogs = await provider.getLogs({
      fromBlock: from,
      toBlock: to,
      address: NOXA_FACTORY,
      topics: [TOKEN_LAUNCHED_TOPIC],
    });
    for (const log of noxaLogs) await notifyNoxaLaunch(log);
  } catch (e) {
    console.error("noxa log scan error:", e.message);
  }

  // B) direct contract deployments — blocks fetched in parallel batches
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

  // C) pool creations + liquidity adds for the whole range (one call)
  const liqLogs = await provider.getLogs({
    fromBlock: from,
    toBlock: to,
    topics: [[TOPICS.V2_MINT, TOPICS.V3_MINT, TOPICS.PAIR_CREATED, TOPICS.POOL_CREATED]],
  });
  for (const log of liqLogs) {
    const t = log.topics[0];
    if (t === TOPICS.PAIR_CREATED || t === TOPICS.POOL_CREATED) {
      // birth certificate: remember this pool as genuinely new (no alert yet)
      registerNewPool(log);
    } else {
      // liquidity added: alert only if the pool was born under our watch
      await notifyLiquidity(log);
    }
  }

  // D) LP burns/locks: ONLY transfers to dead/locker addresses (filtered by
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
}

// ---------- main loop ----------
async function main() {
  let last = await provider.getBlockNumber();
  console.log(`Watching ${RPC} from block ${last}`);
  console.log(`NOXA factory: ${NOXA_FACTORY} (alerts ${EXCLUDE_NOXA ? "MUTED" : "ON"})`);
  await send(`✅ Robinhood Chain watcher online. Starting at block ${last}. NOXA alerts: ${EXCLUDE_NOXA ? "off" : "on"}.`);

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
