import express from "express";
import cors from "cors";
import crypto from "crypto";
import pg from "pg";
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const signerWallet = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY);

const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
const CHAIN_ID = Number(process.env.CHAIN_ID);
const CREATOR_SHARE = 0.50;
const MIN_CLAIM_DAI = 1.00;

app.get("/api/health", (req, res) => res.json({ status: "ok", signer: signerWallet.address, port: process.env.PORT || 3001 }));

app.post("/api/register-player", async (req, res) => {
  const { userAddress, deviceId } = req.body;
  const clientIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

  if (!ethers.isAddress(userAddress) || !deviceId || deviceId.length < 8) {
    return res.status(400).json({ error: "Valid wallet address and device ID required" });
  }

  const wallet = userAddress.toLowerCase();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM players WHERE wallet_address = $1", [wallet]);
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      return res.json({ status: "existing", player: existing.rows[0] });
    }

    const deviceCount = await client.query("SELECT COUNT(*) FROM players WHERE device_id = $1", [deviceId]);
    if (Number(deviceCount.rows[0].count) >= 2) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Device account limit reached" });
    }

    const ipCount = await client.query("SELECT COUNT(*) FROM players WHERE ip_address = $1", [clientIp]);
    if (Number(ipCount.rows[0].count) >= 5) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Network account limit reached" });
    }

    const created = await client.query(
      "INSERT INTO players (wallet_address, device_id, ip_address) VALUES ($1, $2, $3) RETURNING *",
      [wallet, deviceId, clientIp]
    );
    await client.query("COMMIT");
    return res.status(201).json({ status: "created", player: created.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
app.get("/api/s2s-ad-reward", async (req, res) => {
  const { user_id, event_id, network, revenue, secret } = req.query;
  if (secret !== process.env.S2S_SECRET_KEY) return res.status(403).send("Unauthorized");
  if (!ethers.isAddress(user_id) || !event_id) return res.status(400).send("Bad request");
  const wallet = user_id.toLowerCase();
  const adRevenueUsd = parseFloat(revenue) || 0.01;
  const playerRewardDai = Number((adRevenueUsd * (1 - CREATOR_SHARE)).toFixed(6));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const playerRes = await client.query("SELECT is_frozen FROM players WHERE wallet_address = $1 FOR UPDATE", [wallet]);
    if (playerRes.rows.length === 0 || playerRes.rows[0].is_frozen) { await client.query("ROLLBACK"); return res.status(403).send("Invalid or frozen account"); }
    await client.query("INSERT INTO ad_logs (transaction_id, wallet_address, ad_network, estimated_usd, reward_dai) VALUES ($1, $2, $3, $4, $5)", [event_id, wallet, network || "mediation", adRevenueUsd, playerRewardDai]);
    await client.query("UPDATE players SET dai_balance = dai_balance + $1, total_earned = total_earned + $1 WHERE wallet_address = $2", [playerRewardDai, wallet]);
    await client.query("COMMIT");
    return res.status(200).send("OK");
  } catch (err) { await client.query("ROLLBACK"); if (err.code === "23505") return res.status(200).send("Duplicate ignored"); return res.status(500).send(err.message); } finally { client.release(); }
});

app.post("/api/withdraw-dai", async (req, res) => {
  const { userAddress } = req.body;
  if (!ethers.isAddress(userAddress)) return res.status(400).json({ error: "Invalid wallet" });
  const wallet = userAddress.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT dai_balance, is_frozen FROM players WHERE wallet_address = $1 FOR UPDATE", [wallet]);
    if (rows.length === 0) throw new Error("Player not found");
    if (rows[0].is_frozen) throw new Error("Account frozen by anti-cheat");
    const balance = Number(rows[0].dai_balance);
    if (balance < MIN_CLAIM_DAI) throw new Error("Minimum withdrawal is $1.00 DAI");
    await client.query("UPDATE players SET dai_balance = 0 WHERE wallet_address = $1", [wallet]);
    await client.query("COMMIT");
    const amountWei = ethers.parseUnits(balance.toFixed(6), 18);
    const voucherId = "0x" + crypto.randomBytes(32).toString("hex");
    const deadline = Math.floor(Date.now() / 1000) + 15 * 60;
    const messageHash = ethers.solidityPackedKeccak256(["address","uint256","bytes32","uint256","uint256","address"], [userAddress, amountWei, voucherId, deadline, CHAIN_ID, VAULT_ADDRESS]);
    const signature = await signerWallet.signMessage(ethers.getBytes(messageHash));
    return res.json({ amount: amountWei.toString(), voucherId, deadline, signature });
  } catch (err) { await client.query("ROLLBACK"); return res.status(400).json({ error: err.message }); } finally { client.release(); }
});

app.get("/api/admin/overview", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_API_KEY) return res.status(403).json({ error: "Unauthorized" });
  try {
    const rev = await pool.query("SELECT COALESCE(SUM(estimated_usd), 0) AS gross, COALESCE(SUM(reward_dai), 0) AS player_share, COUNT(*) AS views FROM ad_logs WHERE created_at >= NOW() - INTERVAL '24 hours'");
    const ply = await pool.query("SELECT COUNT(*) FILTER (WHERE is_frozen = FALSE) AS active, COUNT(*) FILTER (WHERE is_frozen = TRUE) AS frozen, COALESCE(SUM(dai_balance) FILTER (WHERE is_frozen = FALSE), 0) AS unpaid FROM players");
    const gross24h = Number(rev.rows[0].gross), player24h = Number(rev.rows[0].player_share);
    res.json({ grossAdRevenue24h: gross24h.toFixed(2), netCreatorProfit24h: (gross24h - player24h).toFixed(2), playerRewards24h: player24h.toFixed(2), pendingUnclaimedDai: Number(ply.rows[0].unpaid).toFixed(2), views24h: Number(rev.rows[0].views), activePlayers: Number(ply.rows[0].active), frozenBots: Number(ply.rows[0].frozen) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/admin/withdraw-profit', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { toAddress, amountDai } = req.body;
  if (!ethers.isAddress(toAddress) || !amountDai || Number(amountDai) <= 0) return res.status(400).json({ error: 'Invalid address or amount' });
  try {
    const treasurySigner = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY, provider);
    const dai = new ethers.Contract(process.env.DAI_ADDRESS, ['function transfer(address to, uint256 amount) returns (bool)'], treasurySigner);
    const tx = await dai.transfer(toAddress, ethers.parseUnits(String(amountDai), 18));
    const receipt = await tx.wait();
    res.json({ success: true, txHash: receipt.hash, sentDai: amountDai, recipient: toAddress });
  } catch (err) {
    res.status(500).json({ error: err.reason || err.message });
  }
});
app.listen(process.env.PORT || 3001, () => console.log("API Server Running on Port", process.env.PORT || 3001));
