import { Router } from 'express';
import { getConnectedClient } from '../telegram.js';
import { db } from '../db.js';

export const scanRouter = Router();

function isVideoMessage(msg) {
  const doc = msg.media?.document;
  if (!doc) return false;
  if (doc.mimeType?.startsWith('video/')) return true;
  return doc.attributes?.some((a) => a.className === 'DocumentAttributeVideo');
}

function fileNameOf(msg) {
  const attr = msg.media?.document?.attributes?.find((a) => a.className === 'DocumentAttributeFilename');
  return attr?.fileName || `video_${msg.id}.mp4`;
}

// Scan a group (optionally a forum topic) for video messages, save as `episodes`.
scanRouter.post('/', async (req, res) => {
  try {
    const { groupId, topicId, limit = 200 } = req.body || {};
    if (!groupId) return res.status(400).json({ success: false, error: 'Missing groupId' });

    const { data: group, error: gErr } = await db.from('groups').select('*').eq('id', groupId).maybeSingle();
    if (gErr) throw gErr;
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    let dbTopic = null;
    if (topicId) {
      const { data, error } = await db.from('topics').select('*').eq('id', topicId).maybeSingle();
      if (error) throw error;
      dbTopic = data;
    }

    const client = await getConnectedClient();
    const iterOpts = { limit: Number(limit) };
    if (dbTopic?.topic_id) iterOpts.replyTo = Number(dbTopic.topic_id);

    const found = [];
    for await (const msg of client.iterMessages(group.chat_id, iterOpts)) {
      if (!isVideoMessage(msg)) continue;
      found.push({
        group_id: group.id,
        topic_id: dbTopic?.id || null,
        message_id: String(msg.id),
        title: msg.message?.slice(0, 200) || fileNameOf(msg),
        file_name: fileNameOf(msg),
        file_size: Number(msg.media?.document?.size || 0),
        duration: Number(
          msg.media?.document?.attributes?.find((a) => a.className === 'DocumentAttributeVideo')?.duration || 0
        ),
        status: 'pending',
      });
    }

    let saved = [];
    if (found.length) {
      // Skip message_ids we've already recorded for this group/topic.
      const { data: existing } = await db
        .from('episodes')
        .select('message_id')
        .eq('group_id', group.id);
      const already = new Set((existing || []).map((e) => e.message_id));
      const toInsert = found.filter((f) => !already.has(f.message_id));

      if (toInsert.length) {
        const { data, error } = await db.from('episodes').insert(toInsert).select();
        if (error) throw error;
        saved = data;
      }
    }

    await db
      .from('groups')
      .update({ total_episodes: found.length, last_scanned_at: new Date().toISOString() })
      .eq('id', group.id);

    res.json({ success: true, scanned: found.length, newEpisodes: saved.length, episodes: saved });
  } catch (err) {
    res.status(400).json({ success: false, error: err.errorMessage || err.message });
  }
});
