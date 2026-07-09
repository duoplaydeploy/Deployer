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
async function isVerified(addr) {
  try {
    const res = await fetch(`${EXPLORER}/api/v2/smart-contracts/${addr}`);
    if (!res.ok) return false;
    const j = await res.json();
    return Boolean(j.is_verified || j.name);
  } catch {
    return false;
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
async function send(text) {
  for (let i = 0; i < 3; i++) {
    try {
      await bot.sendMessage(TG_CHAT, text, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      return;
    } catch (e) {
      if (i === 2) console.error("tg send failed:", e.message);
      else await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

function fmtSupply(supply, decimals) {
  const human = Number(supply) / 10 ** Number(decimals || 18);
  return human.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// ---------- per-token status (for the ✅/❌ checklist) ----------
// addr(lower) -> { name, symbol, supplyStr, deployer, pool,
//                  deployed, verified, launching, lp, isToken, noxa }
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
      deployed: true, verified: false, launching: false, lp: false,
    };
    s.verified = await isVerified(addr);
    tokenStatus.set(key, s);
  }
  Object.assign(s, patch);
  return s;
}

function statusChecklist(addr) {
  const s = tokenStatus.get(addr.toLowerCase()) || {};
  const row = (ok, n, title, sub) =>
    `${ok ? "✅" : "❌"} *#${n} ${title}*\n     _${sub}_`;
  return [
    row(s.deployed, 1, "CONTRACT DEPLOYED", "Smart contract on-chain"),
    row(s.verified, 2, "CONTRACT VERIFIED", "Code human-readable on explorer"),
    row(s.launching, 3, "LAUNCHING", "Pair created — live or about to be"),
    row(s.lp, 4, "LIQUIDITY LOCKED / BURNED", "LP locked via third party or burned"),
  ].join("\n");
}

// ---------- the unified card ----------
// Every alert (new token / launching / lock / burn / noxa) uses this format.
function card({ header, addr, s, pairLabel, extras = [], txHash }) {
  const lines = [header, ""];
  lines.push(`Name: *${s.name}*`);
  lines.push(`Ticker: *${s.symbol}*`);
  if (s.supplyStr) lines.push(`Supply: ${s.supplyStr}`);
  if (pairLabel) lines.push(`Pair: ${pairLabel}`);
  for (const ex of extras) lines.push(ex);
  lines.push("", statusChecklist(addr), "");
  lines.push(`CA: \`${addr}\``);
  if (s.deployer) lines.push(`Deployer: \`${s.deployer}\``);
  const links = [
    txHash ? `[Tx](${EXPLORER}/tx/${txHash})` : null,
    `[Contract](${EXPLORER}/address/${addr})`,
    `[Holders](${EXPLORER}/token/${addr}?tab=holders)`,
    s.noxa ? `[Trade](https://fun.noxa.fi/robinhood)` : null,
  ].filter(Boolean).join(" · ");
  lines.push(links);
  return lines.join("\n");
}

// one card per token per stage
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
  });

  let pairLabel = null;
  try {
    const pairInfo = await readToken(ev.args.pairToken);
    if (pairInfo.isToken) pairLabel = `${s.symbol} / ${pairInfo.symbol}`;
  } catch { /* koi baat nahi */ }

  const tag = classify(s.name, s.symbol);
  await send(card({
    header: `🟢 *NOXA FUN LAUNCH* (${tag})`,
    addr: token,
    s,
    pairLabel,
    extras: [`Initial buy: ${ethers.formatEther(ev.args.initialBuyAmount)} ETH`],
    txHash: log.transactionHash,
  }));
}

// Direct contract deployment (someone deploys their own token)
async function notifyDeploy(tx, receipt) {
  const addr = receipt.contractAddress;

  // rare: direct deploy that touches noxa infra
  if (isNoxaTx(receipt)) {
    noxaAddrs.add(addr.toLowerCase());
    if (EXCLUDE_NOXA) return;
  }

  const s = await getStatus(addr, { deployer: tx.from, deployed: true });
  if (!s.isToken) return; // not an ERC20 — skip
  if (!once("deploy", addr)) return;

  const tag = classify(s.name, s.symbol);
  await send(card({
    header: `🆕 *NEW TOKEN* (${tag})`,
    addr,
    s,
    txHash: tx.hash,
  }));
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
  const s = await getStatus(m.mainAddr, { launching: true, pool: log.address });
  if (!once("launching", m.mainAddr)) return;

  const tag = classify(s.name, s.symbol);
  await send(card({
    header: `🚀 *LAUNCHING* (${tag})`,
    addr: m.mainAddr,
    s,
    pairLabel: m.pairLabel,
    txHash: log.transactionHash,
  }));
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
  const s = await getStatus(m.mainAddr, { lp: true, launching: true });
  if (!once(`lp:${kind}`, m.mainAddr)) return;

  const header = kind === "burnt"
    ? `🔥 *LIQUIDITY BURNED*`
    : `🔒 *LIQUIDITY LOCKED*`;
  await send(card({
    header,
    addr: m.mainAddr,
    s,
    pairLabel: m.pairLabel,
    extras: [`LP token: \`${log.address}\``],
    txHash: log.transactionHash,
  }));
}

// ---------- block scanner ----------
async function scanBlock(blockNumber) {
  const block = await provider.getBlock(blockNumber, true);
  if (!block) return;

  // 0) NOXA launches first — registers noxa pools before liquidity scanning
  try {
    const noxaLogs = await provider.getLogs({
      fromBlock: blockNumber,
      toBlock: blockNumber,
      address: NOXA_FACTORY,
      topics: [TOKEN_LAUNCHED_TOPIC],
    });
    for (const log of noxaLogs) await notifyNoxaLaunch(log);
  } catch (e) {
    console.error("noxa log scan error:", e.message);
  }

  // 1) direct contract deployments
  for (const tx of block.prefetchedTransactions) {
    if (tx.to === null) {
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (receipt?.contractAddress && receipt.status === 1) {
        await notifyDeploy(tx, receipt);
      }
    }
  }

  // 2) liquidity events + burn/lock
  const logs = await provider.getLogs({
    fromBlock: blockNumber,
    toBlock: blockNumber,
    topics: [[TOPICS.V2_MINT, TOPICS.V3_MINT, TOPICS.PAIR_CREATED, TOPICS.POOL_CREATED, TOPICS.TRANSFER]],
  });
  for (const log of logs) {
    const t = log.topics[0];
    if (t === TOPICS.PAIR_CREATED || t === TOPICS.POOL_CREATED) {
      // birth certificate: remember this pool as genuinely new (no alert yet)
      registerNewPool(log);
    } else if (t === TOPICS.V2_MINT || t === TOPICS.V3_MINT) {
      // liquidity added: alert only if the pool was born under our watch
      await notifyLiquidity(log);
    } else if (t === TOPICS.TRANSFER && log.topics.length === 3) {
      const to = topicAddr(log.topics[2]);
      if (DEAD_ADDRS.has(to)) await notifyBurnLock(log, "burnt");
      else if (LOCKER_ADDRS.has(to)) await notifyBurnLock(log, "locked");
    }
  }
}

// ---------- main loop ----------
async function main() {
  let last = await provider.getBlockNumber();
  console.log(`Watching ${RPC} from block ${last}`);
  console.log(`NOXA factory: ${NOXA_FACTORY} (alerts ${EXCLUDE_NOXA ? "MUTED" : "ON"})`);
  await send(`✅ Robinhood Chain watcher online. Starting at block ${last}. NOXA alerts: ${EXCLUDE_NOXA ? "off" : "on"}.`);

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const head = await provider.getBlockNumber();
      for (let n = last + 1; n <= head; n++) await scanBlock(n);
      last = head;
    } catch (e) {
      console.error("poll error:", e.message);
    } finally {
      busy = false;
    }
  }, POLL_MS);
}

main();
