import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL.trim());
const signerWallet = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY.trim());
app.get('/api/health', (req, res) => res.json({ status: 'ok', signer: signerWallet.address, chainId: process.env.CHAIN_ID || '84532' }));
app.post('/api/register-player', async (req, res) => {
  const { userAddress, deviceId } = req.body;
  if (!ethers.isAddress(userAddress) || !deviceId) return res.status(400).json({ error: 'Invalid input' });
  const w = userAddress.toLowerCase();
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    const ex = await pool.query('SELECT wallet_address FROM players WHERE wallet_address = $1', [w]);
    if (ex.rowCount === 0) {
      const dc = await pool.query('SELECT COUNT(*) FROM players WHERE device_id = $1', [deviceId]);
      if (Number(dc.rows[0].count) >= 2) return res.status(403).json({ error: 'Device limit reached' });
    }
    const r = await pool.query('INSERT INTO players (wallet_address, device_id, last_ip) VALUES ($1, $2, $3) ON CONFLICT (wallet_address) DO UPDATE SET last_ip = $3 RETURNING wallet_address, dai_balance, total_earned, status', [w, deviceId, ip]);
    res.json({ player: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/enter-tournament', async (req, res) => {
  const { userAddress, txHash } = req.body;
  if (!ethers.isAddress(userAddress) || !txHash) return res.status(400).json({ error: 'Invalid input' });
  const w = userAddress.toLowerCase();
  const tr = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY.trim()).address.toLowerCase();
  const da = process.env.DAI_ADDRESS.trim().toLowerCase();
  const c = await pool.connect();
  try {
    const rc = await provider.getTransactionReceipt(txHash);
    if (!rc || rc.status !== 1) return res.status(400).json({ error: 'Tx not confirmed' });
    const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
    let ok = false, lvls = 1;
    for (const l of rc.logs) {
      if (l.address.toLowerCase() === da) {
        try {
          const p = iface.parseLog(l);
          if (p && p.args.from.toLowerCase() === w && p.args.to.toLowerCase() === tr && p.args.value >= ethers.parseUnits('5', 18)) {
            ok = true;
            lvls = Math.max(1, Math.floor(Number(ethers.formatUnits(p.args.value, 18)) / 5));
          }
        } catch (e) {}
      }
    }
    if (!ok) return res.status(400).json({ error: 'Valid $5+ DAI transfer not found' });
    await c.query('BEGIN');
    const dup = await c.query('SELECT transaction_id FROM ad_logs WHERE transaction_id = $1', [txHash.toLowerCase()]);
    if (dup.rowCount > 0) { await c.query('ROLLBACK'); return res.status(409).json({ error: 'Tx already used' }); }
    const usd = lvls * 5;
    await c.query('INSERT INTO ad_logs (transaction_id, wallet_address, ad_network, estimated_usd, reward_dai) VALUES ($1, $2, $3, $4, $5)', [txHash.toLowerCase(), w, 'level_unlock_' + lvls, usd, 0]);
    await c.query('COMMIT');
    res.json({ unlocked: true, levelsUnlocked: lvls, entryFee: usd, creatorProfit: usd });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.post('/api/withdraw-dai', async (req, res) => {
  const { userAddress } = req.body;
  if (!ethers.isAddress(userAddress)) return res.status(400).json({ error: 'Invalid wallet' });
  const w = userAddress.toLowerCase(), c = await pool.connect();
  try {
    await c.query('BEGIN');
    const p = await c.query('SELECT dai_balance, status FROM players WHERE wallet_address = $1 FOR UPDATE', [w]);
    if (p.rowCount === 0 || p.rows[0].status !== 'active') { await c.query('ROLLBACK'); return res.status(403).json({ error: 'Invalid or frozen' }); }
    const bal = Number(p.rows[0].dai_balance);
    if (bal < 1) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'Min $1.00 DAI' }); }
    const wei = ethers.parseUnits(bal.toFixed(6), 18), vid = ethers.hexlify(ethers.randomBytes(32)), dl = Math.floor(Date.now() / 1000) + 900;
    const h = ethers.solidityPackedKeccak256(['address', 'uint256', 'bytes32', 'uint256', 'uint256', 'address'], [w, wei, vid, dl, Number(process.env.CHAIN_ID), process.env.VAULT_ADDRESS.trim()]);
    const sig = await signerWallet.signMessage(ethers.getBytes(h));
    await c.query('UPDATE players SET dai_balance = 0 WHERE wallet_address = $1', [w]);
    await c.query('INSERT INTO withdrawals (voucher_id, wallet_address, amount_dai) VALUES ($1, $2, $3)', [vid, w, bal]);
    await c.query('COMMIT');
    res.json({ amount: wei.toString(), voucherId: vid, deadline: dl, signature: sig });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.post('/api/admin/withdraw-profit', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { toAddress, amountDai } = req.body;
  if (!ethers.isAddress(toAddress) || !amountDai || Number(amountDai) <= 0) return res.status(400).json({ error: 'Invalid input' });
  try {
    const ts = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY.trim(), provider);
    const dai = new ethers.Contract(process.env.DAI_ADDRESS.trim(), ['function transfer(address, uint256) returns (bool)'], ts);
    const tx = await dai.transfer(toAddress, ethers.parseUnits(String(amountDai), 18));
    const rc = await tx.wait();
    res.json({ success: true, txHash: rc.hash, sentDai: amountDai });
  } catch (e) { res.status(500).json({ error: e.reason || e.message }); }
});
app.listen(process.env.PORT || 3001, () => console.log('API Running'));
app.post('/api/withdraw-dai', async (req, res) => {
  const { userAddress } = req.body;
  if (!ethers.isAddress(userAddress)) return res.status(400).json({ error: 'Invalid wallet' });
  const w = userAddress.toLowerCase(), c = await pool.connect();
  try {
    await c.query('BEGIN');
    const p = await c.query('SELECT dai_balance, status FROM players WHERE wallet_address = $1 FOR UPDATE', [w]);
    if (p.rowCount === 0 || p.rows[0].status !== 'active') { await c.query('ROLLBACK'); return res.status(403).json({ error: 'Invalid or frozen' }); }
    const bal = Number(p.rows[0].dai_balance);
    if (bal < 1) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'Min $1.00 DAI' }); }
    const wei = ethers.parseUnits(bal.toFixed(6), 18), vid = ethers.hexlify(ethers.randomBytes(32)), dl = Math.floor(Date.now() / 1000) + 900;
    const h = ethers.solidityPackedKeccak256(['address', 'uint256', 'bytes32', 'uint256', 'uint256', 'address'], [w, wei, vid, dl, Number(process.env.CHAIN_ID), process.env.VAULT_ADDRESS.trim()]);
    const sig = await signerWallet.signMessage(ethers.getBytes(h));
    await c.query('UPDATE players SET dai_balance = 0 WHERE wallet_address = $1', [w]);
    await c.query('INSERT INTO withdrawals (voucher_id, wallet_address, amount_dai) VALUES ($1, $2, $3)', [vid, w, bal]);
    await c.query('COMMIT');
    res.json({ amount: wei.toString(), voucherId: vid, deadline: dl, signature: sig });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.post('/api/admin/withdraw-profit', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { toAddress, amountDai } = req.body;
  if (!ethers.isAddress(toAddress) || !amountDai || Number(amountDai) <= 0) return res.status(400).json({ error: 'Invalid input' });
  try {
    const ts = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY.trim(), provider);
    const dai = new ethers.Contract(process.env.DAI_ADDRESS.trim(), ['function transfer(address, uint256) returns (bool)'], ts);
    const tx = await dai.transfer(toAddress, ethers.parseUnits(String(amountDai), 18));
    const rc = await tx.wait();
    res.json({ success: true, txHash: rc.hash, sentDai: amountDai });
  } catch (e) { res.status(500).json({ error: e.reason || e.message }); }
});
app.get('/api/admin/overview', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const st = await pool.query('SELECT COALESCA(SUM(estimated_usd), 0) AS g, COALESCE(SUM(reward_dai), 0) AS r, COUNT(*) AS v FROM ad_logs WHERE created_at > NOW() - INTERVAL \'24 hours\'');
    const pn = await pool.query('SELECT COALESCA(SUM(dai_balance), 0) AS p FROM players');
    const pl = await pool.query("SELECT COUNT(*) FROM players WHERE status = 'active'");
    const bt = await pool.query("SELECT COALESCA(COUNT(*), 0) FROM players WHERE status = 'frozen'");
    const g = Number(st.rows[0].g), r = Number(st.rows[0].r);
    res.json({ grossAdRevenue24h: g.toFixed(2), netCreatorProfit24h: (g - r).toFixed(2), playerRewards24h: r.toFixed(2), pendingUnclaimedDai: Number(pn.rows[0].p).toFixed(2), views24h: Number(st.rows[0].v), activePlayers: Number(pl.rows[0].count), frozenBots: Number(bt.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.listen(process.env.PORT || 3001, () => console.log('API Running'));
