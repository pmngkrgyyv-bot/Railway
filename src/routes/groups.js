import { Router } from 'express';
import { getConnectedClient } from '../telegram.js';
import { db } from '../db.js';

export const groupsRouter = Router();

// Fetch groups/channels from Telegram and upsert them into the `groups` table.
groupsRouter.post('/sync', async (req, res) => {
  try {
    const client = await getConnectedClient();
    const dialogs = await client.getDialogs({ limit: 200 });

    const rows = dialogs
      .filter((d) => d.isGroup || d.isChannel)
      .map((d) => ({
        chat_id: String(d.id),
        title: d.title || d.name || 'Untitled',
        username: d.entity?.username || null,
        is_forum: Boolean(d.entity?.forum),
      }));

    let upserted = [];
    if (rows.length) {
      const { data, error } = await db
        .from('groups')
        .upsert(rows, { onConflict: 'chat_id' })
        .select();
      if (error) throw error;
      upserted = data;
    }

    res.json({ success: true, count: upserted.length, groups: upserted });
  } catch (err) {
    res.status(400).json({ success: false, error: err.errorMessage || err.message });
  }
});
