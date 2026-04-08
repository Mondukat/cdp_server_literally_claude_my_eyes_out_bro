import express from "express";
import cors from "cors";
import crypto from "crypto";
import { Coinbase, Wallet } from "@coinbase/coinbase-sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());

// Raw body ONLY for /webhook (must come before express.json)
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ── CDP Auth ────────────────────────────────────────────────────────────────
let cdp;
if (process.env.CDP_API_KEY_NAME && process.env.CDP_API_KEY_PRIVATE_KEY) {
  const rawKey = process.env.CDP_API_KEY_PRIVATE_KEY;
  const privateKey = rawKey.includes("\\n")
    ? rawKey.replace(/\\n/g, "\n")
    : rawKey;
  cdp = new Coinbase({
    apiKeyName: process.env.CDP_API_KEY_NAME,
    privateKey,
  });
} else if (fs.existsSync("cdp_api_key.json")) {
  cdp = Coinbase.configureFromJson({ filePath: "cdp_api_key.json" });
} else {
  console.error("❌ No CDP credentials found. Set CDP_API_KEY_NAME + CDP_API_KEY_PRIVATE_KEY env vars.");
  process.exit(1);
}

// ── Wallet persistence ───────────────────────────────────────────────────────
const WALLETS_FILE = path.join(__dirname, "wallets.json");

function loadWallets() {
  if (!fs.existsSync(WALLETS_FILE)) return {};
  return JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
}

function saveWallets(data) {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(data, null, 2));
}

// ── SSE client registry ──────────────────────────────────────────────────────
const sseClients = new Set();

// ── Routes ───────────────────────────────────────────────────────────────────

// Health
app.get("/", (req, res) => res.json({ status: "ok", service: "cdp-server-wallet", sseClients: sseClients.size }));

// ── CDP Webhook receiver ─────────────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  const sig = req.headers["x-cdp-webhook-signature"];
  const secret = process.env.CDP_WEBHOOK_SECRET;

  if (secret) {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("hex");
    if (sig !== `sha256=${expected}`) {
      console.warn("[webhook] signature mismatch");
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  let event;
  try {
    event = JSON.parse(req.body);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  console.log(`[webhook] ${event.type || "unknown"} on ${event.network || "-"}`);

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }

  res.status(200).json({ ok: true });
});

// ── SSE stream (dashboard connects here) ─────────────────────────────────────
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 30_000);
  sseClients.add(res);
  console.log(`[sse] client connected | total: ${sseClients.size}`);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`[sse] client disconnected | total: ${sseClients.size}`);
  });
});

// ── Wallet routes (unchanged) ─────────────────────────────────────────────────

app.post("/wallet/create", async (req, res) => {
  try {
    const networkId = req.body.networkId || "base-mainnet";
    const wallet = await Wallet.create({ networkId });
    const data = await wallet.export();
    const defaultAddress = await wallet.getDefaultAddress();
    const address = defaultAddress.getId();
    const walletId = wallet.getId();

    const wallets = loadWallets();
    wallets[walletId] = { ...data, networkId, address, createdAt: new Date().toISOString() };
    saveWallets(wallets);

    res.json({ walletId, address, networkId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, apiCode: err.apiCode, apiMessage: err.apiMessage, httpCode: err.httpCode });
  }
});

app.get("/wallet/list", (req, res) => {
  const wallets = loadWallets();
  const list = Object.entries(wallets).map(([id, w]) => ({
    walletId: id,
    address: w.address,
    networkId: w.networkId,
    createdAt: w.createdAt,
  }));
  res.json({ wallets: list });
});

app.get("/wallet/:walletId/balance", async (req, res) => {
  try {
    const wallets = loadWallets();
    const data = wallets[req.params.walletId];
    if (!data) return res.status(404).json({ error: "Wallet not found" });

    const wallet = await Wallet.import(data);
    const balances = await wallet.listBalances();
    const result = {};
    for (const [asset, bal] of balances) result[asset] = bal.toString();

    res.json({ walletId: req.params.walletId, address: data.address, balances: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/wallet/:walletId/send", async (req, res) => {
  try {
    const { to, amount, assetId = Coinbase.assets.Eth } = req.body;
    if (!to || !amount) return res.status(400).json({ error: "Missing to or amount" });

    const wallets = loadWallets();
    const data = wallets[req.params.walletId];
    if (!data) return res.status(404).json({ error: "Wallet not found" });

    const wallet = await Wallet.import(data);
    const transfer = await wallet.createTransfer({
      amount: parseFloat(amount),
      assetId,
      destination: to,
      gasless: assetId === "usdc",
    });
    await transfer.wait();

    res.json({ status: transfer.getStatus(), txHash: transfer.getTransactionHash(), from: data.address, to, amount, assetId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/wallet/:walletId/faucet", async (req, res) => {
  try {
    const wallets = loadWallets();
    const data = wallets[req.params.walletId];
    if (!data) return res.status(404).json({ error: "Wallet not found" });
    if (!data.networkId.includes("sepolia")) return res.status(400).json({ error: "Faucet only available on testnet" });

    const wallet = await Wallet.import(data);
    const faucet = await wallet.faucet();
    res.json({ txHash: faucet.getTransactionHash(), status: "funded" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/wallet/:walletId/sign", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Missing message" });

    const wallets = loadWallets();
    const data = wallets[req.params.walletId];
    if (!data) return res.status(404).json({ error: "Wallet not found" });

    const wallet = await Wallet.import(data);
    const address = await wallet.getDefaultAddress();
    const signature = await address.signPayload({ unsigned_payload: Buffer.from(message).toString("hex") });

    res.json({ signature, message, address: data.address });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Advanced Trade API ───────────────────────────────────────────────────────
// Uses CDP API keys to authenticate with Coinbase Advanced Trade REST API
// Base URL: https://api.coinbase.com

function buildJWT(method, path) {
  const keyName = process.env.CDP_API_KEY_NAME;
  const rawKey = process.env.CDP_API_KEY_PRIVATE_KEY;
  if (!keyName || !rawKey) throw new Error("CDP credentials not configured");

  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
  const uri = `${method} api.coinbase.com${path}`;
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "ES256", kid: keyName, nonce: crypto.randomBytes(16).toString("hex"), typ: "JWT" };
  const payload = { sub: keyName, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120, uris: [uri] };

  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  const sig = sign.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });

  return `${signingInput}.${sig.toString("base64url")}`;
}

async function advancedTradeRequest(method, path, body = null) {
  const jwt = buildJWT(method, path);
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`https://api.coinbase.com${path}`, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`AT API ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

// List all accounts (exchange balances)
app.get("/trade/accounts", async (req, res) => {
  try {
    const data = await advancedTradeRequest("GET", "/api/v3/brokerage/accounts");
    res.json(data);
  } catch (err) {
    console.error("[trade/accounts]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// List portfolios
app.get("/trade/portfolios", async (req, res) => {
  try {
    const data = await advancedTradeRequest("GET", "/api/v3/brokerage/portfolios");
    res.json(data);
  } catch (err) {
    console.error("[trade/portfolios]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Portfolio breakdown
app.get("/trade/portfolios/:portfolioId", async (req, res) => {
  try {
    const data = await advancedTradeRequest("GET", `/api/v3/brokerage/portfolios/${req.params.portfolioId}`);
    res.json(data);
  } catch (err) {
    console.error("[trade/portfolio]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get product (market) info
app.get("/trade/products", async (req, res) => {
  try {
    const limit = req.query.limit || 50;
    const data = await advancedTradeRequest("GET", `/api/v3/brokerage/products?limit=${limit}`);
    res.json(data);
  } catch (err) {
    console.error("[trade/products]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get specific product
app.get("/trade/products/:productId", async (req, res) => {
  try {
    const data = await advancedTradeRequest("GET", `/api/v3/brokerage/products/${req.params.productId}`);
    res.json(data);
  } catch (err) {
    console.error("[trade/product]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get product candles
app.get("/trade/products/:productId/candles", async (req, res) => {
  try {
    const { start, end, granularity = "ONE_HOUR" } = req.query;
    let qs = `?granularity=${granularity}`;
    if (start) qs += `&start=${start}`;
    if (end) qs += `&end=${end}`;
    const data = await advancedTradeRequest("GET", `/api/v3/brokerage/products/${req.params.productId}/candles${qs}`);
    res.json(data);
  } catch (err) {
    console.error("[trade/candles]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Place order
app.post("/trade/orders", async (req, res) => {
  try {
    const { product_id, side, order_type = "market", size, limit_price, client_order_id } = req.body;
    if (!product_id || !side) return res.status(400).json({ error: "Missing product_id or side" });

    const orderConfig = {};
    if (order_type === "market") {
      if (side === "BUY") orderConfig.market_market_ioc = { quote_size: size };
      else orderConfig.market_market_ioc = { base_size: size };
    } else if (order_type === "limit") {
      orderConfig.limit_limit_gtc = { base_size: size, limit_price, post_only: false };
    }

    const data = await advancedTradeRequest("POST", "/api/v3/brokerage/orders", {
      client_order_id: client_order_id || crypto.randomUUID(),
      product_id,
      side: side.toUpperCase(),
      order_configuration: orderConfig,
    });
    res.json(data);
  } catch (err) {
    console.error("[trade/orders]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// List orders
app.get("/trade/orders", async (req, res) => {
  try {
    const { product_id, status = "OPEN" } = req.query;
    let qs = `?order_status=${status}`;
    if (product_id) qs += `&product_id=${product_id}`;
    const data = await advancedTradeRequest("GET", `/api/v3/brokerage/orders/historical/batch${qs}`);
    res.json(data);
  } catch (err) {
    console.error("[trade/orders/list]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cancel order
app.delete("/trade/orders/:orderId", async (req, res) => {
  try {
    const data = await advancedTradeRequest("POST", "/api/v3/brokerage/orders/batch_cancel", {
      order_ids: [req.params.orderId],
    });
    res.json(data);
  } catch (err) {
    console.error("[trade/orders/cancel]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Transaction history
app.get("/trade/transactions", async (req, res) => {
  try {
    const data = await advancedTradeRequest("GET", "/api/v3/brokerage/transaction_summary");
    res.json(data);
  } catch (err) {
    console.error("[trade/transactions]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ CDP Server Wallet + Advanced Trade running on port ${PORT}`));
// deployed 20260407T155641Z
// redeploy 20260408T165122Z
