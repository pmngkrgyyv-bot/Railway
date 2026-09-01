import { Router } from 'express';
import { sendCode, verifyCode, logout } from '../telegram.js';
import { getTelegramSettings } from '../db.js';

export const authRouter = Router();

authRouter.post('/send-code', async (req, res) => {
  try {
    const result = await sendCode();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

authRouter.post('/verify-code', async (req, res) => {
  try {
    const { code, password } = req.body || {};
    if (!code) return res.status(400).json({ success: false, error: 'Missing code' });
    const result = await verifyCode({ code, password });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.errorMessage || err.message });
  }
});

authRouter.get('/status', async (req, res) => {
  try {
    const settings = await getTelegramSettings();
    res.json({
      connected: Boolean(settings?.connected && settings?.session_string),
      phone: settings?.phone || null,
      last_connected_at: settings?.last_connected_at || null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

authRouter.post('/logout', async (req, res) => {
  try {
    await logout();
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});
