import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
}

export const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

export async function getTelegramSettings() {
  const { data, error } = await db.from('telegram_settings').select('*').maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveTelegramSettings(patch) {
  const existing = await getTelegramSettings();
  if (existing?.id) {
    const { data, error } = await db
      .from('telegram_settings')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  const { data, error } = await db.from('telegram_settings').insert(patch).select().maybeSingle();
  if (error) throw error;
  return data;
}

export async function getR2Settings() {
  const { data, error } = await db.from('r2_settings').select('*').maybeSingle();
  if (error) throw error;
  return data;
}
