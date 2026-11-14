import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const signerWallet = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY);

// 1. Health & Standby Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    signer: signerWallet.address,
    chainId: process.env.CHAIN_ID || '84532',
    port: process.env.PORT || 3001
  });
});

// 2. Register Player & Anti-Cheat Device Lock
app.post('/api/register-player', async (req, res) => {
  const { userAddress, deviceId } = req.body;
  if (!ethers.isAddress(userAddress) || !deviceId) {
    return res.status(400).json({ error: 'Valid wallet address and deviceId required' });
  }
  const wallet = userAddress.toLowerCase();
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  try {
    const existing = await pool.query('SELECT wallet_address FROM players WHERE wallet_address = $1', [wallet]);
    if (existing.rowCount === 0) {
      const devCheck = await pool.query('SELECT COUNT(*) FROM players WHERE device_id = $1', [deviceId]);
      if (Number(devCheck.rows[0].count) >= 2) {
        return res.status(403).json({ error: 'Device limit reached (max 2 accounts per device)' });
      }
    }

    const result = await pool.query(
      `INSERT INTO players (wallet_address, device_id, last_ip)
       VALUES ($1, $2, $3)
       ON CONFLICT (wallet_address) DO UPDATE SET last_ip = $3
       RETURNING wallet_address, dai_balance, total_earned, status`,
      [wallet, deviceId, clientIp]
    );
    res.json({ player: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Server-to-Server (S2S) Rewarded Ad Callback (50/50 Split)
app.all('/api/s2s-ad-reward', async (req, res) => {
  const data = { ...req.query, ...req.body };
  const { user_id, event_id, network, revenue, secret } = data;
  if (secret !== process.env.S2S_SECRET_KEY) return res.status(401).json({ error: 'Invalid S2S secret' });
  if (!ethers.isAddress(user_id) || !event_id) return res.status(400).json({ error: 'Invalid user_id or event_id' });

  const wallet = user_id.toLowerCase();
  const grossUsd = parseFloat(revenue || '0.02');
  const rewardDai = Number((grossUsd * 0.50).toFixed(6));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pRes = await client.query('SELECT status FROM players WHERE wallet_address = $1', [wallet]);
    if (pRes.rowCount === 0 || pRes.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Account inactive or frozen' });
    }
    const dup = await client.query('SELECT transaction_id FROM ad_logs WHERE transaction_id = $1', [event_id]);
    if (dup.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({ message: 'Duplicate event ignored' });
    }
    await client.query(
      'INSERT INTO ad_logs (transaction_id, wallet_address, ad_network, estimated_usd, reward_dai) VALUES ($1, $2, $3, $4, $5)',
      [event_id, wallet, network || 'ad_network', grossUsd, rewardDai]
    );
    const upd = await client.query(
      'UPDATE players SET dai_balance = dai_balance + $1, total_earned = total_earned + $1 WHERE wallet_address = $2 RETURNING dai_balance',
      [rewardDai, wallet]
    );
    await client.query('COMMIT');
    res.json({ creditedDai: rewardDai, newBalance: upd.rows[0].dai_balance });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 4. On-Chain $5.00 Level & $50.00 10-Level Bundle Verification
app.post('/api/enter-tournament', async (req, res) => {
  const { userAddress, txHash } = req.body;
  if (!ethers.isAddress(userAddress) || !txHash) return res.status(400).json({ error: 'Invalid input' });

  const wallet = userAddress.toLowerCase();
  const treasury = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY).address.toLowerCase();
  const daiAddr = process.env.DAI_ADDRESS.toLowerCase();

  const client = await pool.connect();
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({ error: 'Transaction not confirmed on-chain' });
    }

    const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
    let validTransfer = false;
    let paidLevels = 1;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === daiAddr) {
        try {
          const parsed = iface.parseLog(log);
          if (
            parsed &&
            parsed.args.from.toLowerCase() === wallet &&
            parsed.args.to.toLowerCase() === treasury &&
            parsed.args.value >= ethers.parseUnits('5', 18)
          ) {
            validTransfer = true;
            paidLevels = Math.max(1, Math.floor(Number(ethers.formatUnits(parsed.args.value, 18)) / 5));
          }
        } catch (e) {}
      }
    }

    if (!validTransfer) {
      return res.status(400).json({ error: 'Valid $5.00+ DAI transfer to treasury not found' });
    }

    await client.query('BEGIN');
    const dup = await client.query('SELECT transaction_id FROM ad_logs WHERE transaction_id = $1', [txHash.toLowerCase()]);
    if (dup.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Transaction already used' });
    }

    const entryUsd = paidLevels * 5.00;
    const poolShareDai = 0.00;

    await client.query(
      'INSERT INTO ad_logs (transaction_id, wallet_address, ad_network, estimated_usd, reward_dai) VALUES ($1, $2, $3, $4, $5)',
      [txHash.toLowerCase(), wallet, 'level_unlock_' + paidLevels, entryUsd, poolShareDai]
    );
    await client.query(
      'UPDATE players SET dai_balance = dai_balance + $1, total_earned = total_earned + $1 WHERE wallet_address = $2',
      [poolShareDai, wallet]
    );
    await client.query('COMMIT');

    res.json({
      unlocked: true,
      levelsUnlocked: paidLevels,
      entryFee: entryUsd,
      creatorProfit: entryUsd
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 5. Player Instant DAI Withdrawal Voucher Signer
app.post('/api/withdraw-dai', async (req, res) => {
  const { userAddress } = req.body;
  if (!ethers.isAddress(userAddress)) return res.status(400).json({ error: 'Invalid wallet address' });
  const wallet = userAddress.toLowerCase();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pRes = await client.query('SELECT dai_balance, status FROM players WHERE wallet_address = $1 FOR UPDATE', [wallet]);
    if (pRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Player not registered' });
    }
    if (pRes.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Account frozen' });
    }
    const balance = Number(pRes.rows[0].dai_balance);
    if (balance < 1.00) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Minimum withdrawal is $1.00 DAI' });
    }

    const amountWei = ethers.parseUnits(balance.toFixed(6), 18);
    const voucherId = ethers.hexlify(ethers.randomBytes(32));
    const deadline = Math.floor(Date.now() / 1000) + 900;

    const hash = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'bytes32', 'uint256', 'uint256', 'address'],
      [wallet, amountWei, voucherId, deadline, Number(process.env.CHAIN_ID), process.env.VAULT_ADDRESS]
    );
    const signature = await signerWallet.signMessage(ethers.getBytes(hash));

    await client.query('UPDATE players SET dai_balance = 0 WHERE wallet_address = $1', [wallet]);
    await client.query(
      'INSERT INTO withdrawals (voucher_id, wallet_address, amount_dai) VALUES ($1, $2, $3)',
      [voucherId, wallet, balance]
    );
    await client.query('COMMIT');

    res.json({ amount: amountWei.toString(), voucherId, deadline, signature });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 6. Creator Profit Sweep to Personal MetaMask
app.post('/api/admin/withdraw-profit', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { toAddress, amountDai } = req.body;
  if (!ethers.isAddress(toAddress) || !amountDai || Number(amountDai) <= 0) {
    return res.status(400).json({ error: 'Invalid address or amount' });
  }
  try {
    const treasurySigner = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY, provider);
    const dai = new ethers.Contract(
      process.env.DAI_ADDRESS,
      ['function transfer(address to, uint256 amount) returns (bool)'],
      treasurySigner
    );
    const tx = await dai.transfer(toAddress, ethers.parseUnits(String(amountDai), 18));
    const receipt = await tx.wait();
    res.json({ success: true, txHash: receipt.hash, sentDai: amountDai, recipient: toAddress });
  } catch (err) {
    res.status(500).json({ error: err.reason || err.message });
  }
});

// 7. Creator Live Revenue & Anti-Cheat Overview
app.get('/api/admin/overview', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) {
