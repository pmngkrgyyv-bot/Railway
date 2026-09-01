import { Router } from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getConnectedClient } from '../telegram.js';
import { db, getR2Settings } from '../db.js';

export const downloadRouter = Router();

function r2Client(r2) {
  return new S3Client({
    region: r2.region || 'auto',
    endpoint: r2.endpoint_url,
    credentials: {
      accessKeyId: r2.access_key_id,
      secretAccessKey: r2.secret_access_key,
    },
    forcePathStyle: true,
  });
}

function r2Key(pattern, group, topic, ep) {
  return (pattern || '{group}/{topic}/EP{ep}')
    .replace('{group}', (group?.title || 'group').replace(/[^\w.-]+/g, '_'))
    .replace('{topic}', (topic?.title || 'main').replace(/[^\w.-]+/g, '_'))
    .replace('{ep}', String(ep?.ep_number ?? ep?.id).slice(0, 40));
}

// Download one episode's video from Telegram and upload it to R2.
downloadRouter.post('/', async (req, res) => {
  const { episodeId } = req.body || {};
  if (!episodeId) return res.status(400).json({ success: false, error: 'Missing episodeId' });

  let downloadRow = null;
  try {
    const { data: episode, error: epErr } = await db
      .from('episodes')
      .select('*, groups(*), topics(*)')
      .eq('id', episodeId)
      .maybeSingle();
    if (epErr) throw epErr;
    if (!episode) return res.status(404).json({ success: false, error: 'Episode not found' });

    const r2 = await getR2Settings();
    if (!r2?.endpoint_url || !r2?.bucket_name) {
      return res.status(400).json({ success: false, error: 'R2 storage is not configured yet.' });
    }

    const { data: dl, error: dlErr } = await db
      .from('downloads')
      .insert({ episode_id: episode.id, status: 'downloading', started_at: new Date().toISOString() })
      .select()
      .maybeSingle();
    if (dlErr) throw dlErr;
    downloadRow = dl;

    await db.from('episodes').update({ status: 'downloading' }).eq('id', episode.id);

    const client = await getConnectedClient();
    const [msg] = await client.getMessages(episode.groups.chat_id, { ids: [Number(episode.message_id)] });
    if (!msg?.media) throw new Error('Original message/video no longer exists on Telegram.');

    const totalBytes = Number(episode.file_size) || Number(msg.media?.document?.size || 0);
    let lastUpdate = 0;
    const buffer = await client.downloadMedia(msg, {
      progressCallback: async (received) => {
        const now = Date.now();
        if (now - lastUpdate < 1500) return; // throttle DB writes
        lastUpdate = now;
        const progress = totalBytes ? Math.min(99, Math.round((Number(received) / totalBytes) * 100)) : 0;
        await db
          .from('downloads')
          .update({ progress, downloaded_bytes: Number(received), total_bytes: totalBytes })
          .eq('id', downloadRow.id);
      },
    });

    const key = r2Key(undefined, episode.groups, episode.topics, episode);
    const client_s3 = r2Client(r2);
    await client_s3.send(
      new PutObjectCommand({
        Bucket: r2.bucket_name,
        Key: key,
        Body: buffer,
        ContentType: 'video/mp4',
      })
    );

    const publicUrl = r2.public_url ? `${r2.public_url.replace(/\/$/, '')}/${key}` : null;

    await db
      .from('downloads')
      .update({
        status: 'completed',
        progress: 100,
        downloaded_bytes: buffer.length,
        total_bytes: buffer.length,
        r2_key: key,
        r2_url: publicUrl,
        completed_at: new Date().toISOString(),
      })
      .eq('id', downloadRow.id);

    await db.from('episodes').update({ status: 'completed', r2_key: key }).eq('id', episode.id);

    res.json({ success: true, r2_key: key, r2_url: publicUrl, bytes: buffer.length });
  } catch (err) {
    const message = err.errorMessage || err.message;
    if (downloadRow) {
      await db.from('downloads').update({ status: 'failed', error: message }).eq('id', downloadRow.id);
    }
    if (episodeId) {
      await db.from('episodes').update({ status: 'failed' }).eq('id', episodeId);
    }
    res.status(400).json({ success: false, error: message });
  }
});
