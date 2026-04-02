import express from "express";
import cors from "cors";
import { Coinbase, Wallet } from "@coinbase/coinbase-sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

// ── CDP Auth ────────────────────────────────────────────────────────────────
// Supports both file-based key (local) and env var (Railway)
let cdp;
if (process.env.CDP_API_KEY_NAME && process.env.CDP_API_KEY_PRIVATE_KEY) {
  // Normalize the private key - handle both escaped \n and real newlines
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

// ── Wallet persistence (file-based, swap for DB in prod) ────────────────────
const WALLETS_FILE = path.join(__dirname, "wallets.json");

function loadWallets() {
  if (!fs.existsSync(WALLETS_FILE)) return {};
  return JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
}

function saveWallets(data) {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(data, null, 2));
}

// ── Routes ──────────────────────────────────────────────────────────────────

// Health
app.get("/", (req, res) => res.json({ status: "ok", service: "cdp-server-wallet" }));

// Create a new server wallet
// POST /wallet/create  { networkId?: "base-mainnet" | "base-sepolia" | "ethereum-mainnet" }
app.post("/wallet/create", async (req, res) => {
  try {
    const networkId = req.body.networkId || "base-mainnet";
    const wallet = await Wallet.create({ networkId });

    const data = await wallet.export();
    const defaultAddress = await wallet.getDefaultAddress();
    const address = defaultAddress.getId();
    const walletId = wallet.getId();

    // Persist
    const wallets = loadWallets();
    wallets[walletId] = { ...data, networkId, address, createdAt: new Date().toISOString() };
    saveWallets(wallets);

    res.json({ walletId, address, networkId });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message || "Unknown error",
      apiCode: err.apiCode,
      apiMessage: err.apiMessage,
      httpCode: err.httpCode,
    });
  }
});

// List all wallets
// GET /wallet/list
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

// Get wallet balance
// GET /wallet/:walletId/balance
app.get("/wallet/:walletId/balance", async (req, res) => {
  try {
    const wallets = loadWallets();
    const data = wallets[req.params.walletId];
    if (!data) return res.status(404).json({ error: "Wallet not found" });

    const wallet = await Wallet.import(data);
    const balances = await wallet.listBalances();

    const result = {};
    for (const [asset, bal] of balances) {
      result[asset] = bal.toString();
    }

    res.json({ walletId: req.params.walletId, address: data.address, balances: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Send native token (ETH/USDC etc)
// POST /wallet/:walletId/send  { to, amount, assetId? }
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
      gasless: assetId === "usdc", // gasless USDC on Base
    });

    await transfer.wait();

    res.json({
      status: transfer.getStatus(),
      txHash: transfer.getTransactionHash(),
      from: data.address,
      to,
      amount,
      assetId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Request testnet funds (faucet — Base Sepolia only)
// POST /wallet/:walletId/faucet
app.post("/wallet/:walletId/faucet", async (req, res) => {
  try {
    const wallets = loadWallets();
    const data = wallets[req.params.walletId];
    if (!data) return res.status(404).json({ error: "Wallet not found" });
    if (!data.networkId.includes("sepolia")) {
      return res.status(400).json({ error: "Faucet only available on testnet" });
    }

    const wallet = await Wallet.import(data);
    const faucet = await wallet.faucet();
    res.json({ txHash: faucet.getTransactionHash(), status: "funded" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Sign a message
// POST /wallet/:walletId/sign  { message }
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

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ CDP Server Wallet running on port ${PORT}`));