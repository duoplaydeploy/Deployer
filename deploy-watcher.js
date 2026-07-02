// deploy-watcher.js — Robinhood Chain contract & liquidity watcher → Telegram
//
// Setup:
//   npm install ethers node-telegram-bot-api
//   1) Create a bot via @BotFather, get the token.
//   2) Add the bot as admin to your channel.
//   3) Get your chat id: post in the channel, then open
//      https://api.telegram.org/bot<TOKEN>/getUpdates  and read chat.id
//   4) Run:  TG_TOKEN=xxx TG_CHAT=-100xxxx node deploy-watcher.js
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

// Set EXCLUDE_NOXA=true in env if you ever want to mute NOXA launch alerts.
const EXCLUDE_NOXA = (process.env.EXCLUDE_NOXA || "false") === "true";

// The factory emits this event on every launch.
// Source: https://docs.noxa.fi/integrations/launchpad/
const NOXA_IFACE = new ethers.Interface([
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)",
]);
const TOKEN_LAUNCHED_TOPIC = NOXA_IFACE.getEvent("TokenLaunched").topicHash;

// Legacy: treasury heuristic kept as a fallback for direct-deploy detection
const NOXA_TREASURY = "0x71f2f1c2dc94cdabfe29cb355119f8683ae0969b";

// NOXA token/pool addresses we've seen (used to avoid duplicate liquidity alerts)
const noxaAddrs = new Set();

// tx receipt ke logs me noxa treasury/factory hai kya?
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

// ---------- ERC20 + classification ----------
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

// Pool/pair contracts expose token0() and token1()
const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

// Pool ke andar koi noxa token hai kya?
async function poolIsNoxa(poolAddr) {
  if (noxaAddrs.has(poolAddr.toLowerCase())) return true;
  try {
    const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
    const [t0, t1] = await Promise.all([pool.token0(), pool.token1()]);
    return noxaAddrs.has(t0.toLowerCase()) || noxaAddrs.has(t1.toLowerCase());
  } catch {
    return false;
  }
}

// Base/quote tokens ko skip karo taaki asli token dikhe (WETH, USDC, etc.)
const BASE_SYMBOLS = /^(weth|eth|usdc|usdt|dai|wbtc)$/i;

// Pool ka main token ka naam/ticker nikaalo
async function poolTokenLabel(poolAddr) {
  try {
    const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
    const [t0, t1] = await Promise.all([pool.token0(), pool.token1()]);
    const [a, b] = await Promise.all([readToken(t0), readToken(t1)]);
    const parts = [];
    // base token (WETH/USDC) ko doosre me daalo, main token pehle
    const main = a.isToken && !BASE_SYMBOLS.test(a.symbol) ? a
               : b.isToken && !BASE_SYMBOLS.test(b.symbol) ? b : a;
    const other = main === a ? b : a;
    if (main?.isToken) parts.push(`*${main.name}* (${main.symbol})`);
    if (other?.isToken) parts.push(other.symbol);
    return parts.length ? parts.join(" / ") : null;
  } catch {
    return null;
  }
}

const MEME_WORDS = /(doge?|inu|shib|pepe|elon|moon|floki|wojak|chad|meme|baby|safe|cum|cat|frog|bonk|wif|turbo|degen|rekt|ape|pump|\bhood\b|gme|wsb|tendies|stonk)/i;
const UTILITY_WORDS = /(gov|dao|stake|vault|protocol|finance|swap|lend|oracle|bridge|usd|eth|wrapped|staked|reward|index|liquidity|yield)/i;

function classify({ name, symbol }) {
  const hay = `${name} ${symbol}`.toLowerCase();
  if (UTILITY_WORDS.test(hay)) return "utility";
  if (MEME_WORDS.test(hay)) return "meme";
  return "meme?"; // naam se pata nahi chala
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

// LP tokens yahan bheje = liquidity locked/burnt
const DEAD_ADDRS = new Set([
  "0x0000000000000000000000000000000000000000", // zero (burn)
  "0x000000000000000000000000000000000000dead", // dead (burn)
]);
// Known LP locker contracts (lowercase). Naye milne pe yahan add kar.
const LOCKER_ADDRS = new Set([
  "0x7f03effbd7ceb22a3f80dd468f67ef27826acd85", // NOXA Launch Locker (Robinhood Chain)
]);

function topicAddr(topic) {
  // 32-byte topic ka last 20 bytes = address
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

// ---------- notifiers ----------
// Ek hi pool/token dobara na bheje iske liye yaad rakho
const seenPools = new Set();
const seenNoxaTokens = new Set();

// NEW: alert for tokens launched via the NOXA Fun factory
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
  const deployer = ev.args.deployer;
  const initialBuy = ev.args.initialBuyAmount;

  const key = token.toLowerCase();
  if (seenNoxaTokens.has(key)) return;
  seenNoxaTokens.add(key);

  // remember token + pool so generic liquidity alerts don't duplicate this
  noxaAddrs.add(token.toLowerCase());
  noxaAddrs.add(pool.toLowerCase());
  seenPools.add(pool.toLowerCase());

  if (EXCLUDE_NOXA) return; // muted via env var

  const info = await readToken(token);
  const tag = info.isToken ? classify(info) : "unknown";

  await send(
    `🟢 *NOXA FUN LAUNCH* (${tag})\n\n` +
    `Name: *${info.isToken ? info.name : "?"}*\n` +
    `Ticker: *${info.isToken ? info.symbol : "?"}*\n` +
    `Supply: ${info.isToken ? fmtSupply(info.supply, info.decimals) : "?"}\n` +
    `Initial buy: ${ethers.formatEther(initialBuy)} ETH\n` +
    `Token: \`${token}\`\n` +
    `Pool (V3): \`${pool}\`\n` +
    `Deployer: \`${deployer}\`\n` +
    `[Tx](${EXPLORER}/tx/${log.transactionHash}) · [Token](${EXPLORER}/address/${token}) · [Trade](https://fun.noxa.fi/robinhood)`
  );
}

async function notifyDeploy(tx, receipt) {
  const addr = receipt.contractAddress;
  const info = await readToken(addr);

  if (!info.isToken) return; // skip non-token contracts — only tokens wanted

  const isNoxa = isNoxaTx(receipt);
  if (isNoxa) noxaAddrs.add(addr.toLowerCase());
  const header = isNoxa
    ? `🟢 *NOXA FUN DEPLOY*\n🚀 *New token deployed*`
    : `🚀 *New token deployed*`;

  const verified = await isVerified(addr);
  const tag = classify({ ...info, verified });

  await send(
    `${header} (${tag})\n\n` +
    `Name: *${info.name}*\n` +
    `Ticker: *${info.symbol}*\n` +
    `Supply: ${fmtSupply(info.supply, info.decimals)}\n` +
    `Verified: ${verified ? "yes" : "no"}\n` +
    `Address: \`${addr}\`\n` +
    `Deployer: \`${tx.from}\`\n` +
    `[Tx](${EXPLORER}/tx/${tx.hash}) · [Contract](${EXPLORER}/address/${addr})`
  );
}

async function notifyLiquidity(log, kind) {
  // noxa pool: already announced by the dedicated NOXA launch alert, skip duplicates
  if (await poolIsNoxa(log.address)) return;
  // "new pool"/"new pair" same address ke liye ek hi baar bhejo
  if (kind === "new pool" || kind === "new pair") {
    const key = log.address.toLowerCase();
    if (seenPools.has(key)) return;
    seenPools.add(key);
  }
  const label = await poolTokenLabel(log.address);
  const head = label ? `\nToken: ${label}` : "";
  await send(
    `💧 *Liquidity event: ${kind}*${head}\n\n` +
    `Pool/Pair: \`${log.address}\`\n` +
    `[Tx](${EXPLORER}/tx/${log.transactionHash}) · [Contract](${EXPLORER}/address/${log.address})`
  );
}

async function notifyBurnLock(log, kind) {
  // noxa pool hai to skip
  if (await poolIsNoxa(log.address)) return;
  // dobara same LP na bheje
  const key = `${kind}:${log.address.toLowerCase()}`;
  if (seenPools.has(key)) return;

  // 0-amount (dust) transfers skip karo
  try {
    const amount = BigInt(log.data);
    if (amount === 0n) return;
  } catch { /* data padha nahi gaya to aage badho */ }

  // sirf tab bolo "liquidity" jab ye sach me pool/LP token ho
  const label = await poolTokenLabel(log.address);
  if (!label) return; // pool nahi hai = normal token burn, ignore

  seenPools.add(key);
  const emoji = kind === "burnt" ? "🔥" : "🔒";
  await send(
    `${emoji} *Liquidity ${kind}*\nToken: ${label}\n\n` +
    `LP token: \`${log.address}\`\n` +
    `[Tx](${EXPLORER}/tx/${log.transactionHash}) · [Contract](${EXPLORER}/address/${log.address})`
  );
}

// ---------- block scanner ----------
async function scanBlock(blockNumber) {
  const block = await provider.getBlock(blockNumber, true);
  if (!block) return;

  // 0) NOXA Fun launches (factory-created tokens — invisible to step 1!)
  //    Do this FIRST so noxa pools are registered before liquidity scanning.
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

  // 1) direct contract deployments (EOA -> new contract)
  for (const tx of block.prefetchedTransactions) {
    if (tx.to === null) {
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (receipt?.contractAddress && receipt.status === 1) {
        await notifyDeploy(tx, receipt);
      }
    }
  }

  // 2) liquidity events + burn/lock (Transfer of LP to dead/locker)
  const logs = await provider.getLogs({
    fromBlock: blockNumber,
    toBlock: blockNumber,
    topics: [[TOPICS.V2_MINT, TOPICS.V3_MINT, TOPICS.PAIR_CREATED, TOPICS.POOL_CREATED, TOPICS.TRANSFER]],
  });
  for (const log of logs) {
    const t = log.topics[0];
    if (t === TOPICS.V2_MINT) await notifyLiquidity(log, "V2 add");
    else if (t === TOPICS.V3_MINT) await notifyLiquidity(log, "V3 add");
    else if (t === TOPICS.PAIR_CREATED) await notifyLiquidity(log, "new pair");
    else if (t === TOPICS.POOL_CREATED) await notifyLiquidity(log, "new pool");
    else if (t === TOPICS.TRANSFER && log.topics.length === 3) {
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
    if (busy) return;          // avoid overlapping polls
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
