import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { getTelegramSettings, saveTelegramSettings } from './db.js';

// In-memory state for the login handshake (send-code -> verify-code).
// A single operator uses this tool, so one pending login at a time is fine.
let pendingClient = null;
let pendingPhoneCodeHash = null;
let pendingPhone = null;

// The "live" client used for groups/scan/download once logged in.
let activeClient = null;

function newClient(apiId, apiHash, sessionString = '') {
  return new TelegramClient(new StringSession(sessionString), Number(apiId), apiHash, {
    connectionRetries: 5,
  });
}

/** Step 1: send the login code to the user's phone. */
export async function sendCode() {
  const settings = await getTelegramSettings();
  if (!settings?.api_id || !settings?.api_hash || !settings?.phone) {
    throw new Error('Save your API ID, API Hash and phone number first.');
  }

  const client = newClient(settings.api_id, settings.api_hash, '');
  await client.connect();

  const result = await client.sendCode(
    { apiId: Number(settings.api_id), apiHash: settings.api_hash },
    settings.phone
  );

  pendingClient = client;
  pendingPhoneCodeHash = result.phoneCodeHash;
  pendingPhone = settings.phone;

  return { phoneCodeHash: result.phoneCodeHash };
}

/** Step 2: verify the code (and 2FA password if Telegram asks for one). */
export async function verifyCode({ code, password }) {
  if (!pendingClient || !pendingPhoneCodeHash) {
    throw new Error('No login in progress. Call send-code first.');
  }
  const settings = await getTelegramSettings();

  try {
    await pendingClient.invoke(
      new Api.auth.SignIn({
        phoneNumber: pendingPhone,
        phoneCodeHash: pendingPhoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (err) {
    const msg = err?.errorMessage || err?.message || '';
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      if (!password) {
        return { needsPassword: true };
      }
      await pendingClient.signInWithPassword(
        { apiId: Number(settings.api_id), apiHash: settings.api_hash },
        {
          password: async () => password,
          onError: (e) => {
            throw e;
          },
        }
      );
    } else {
      throw err;
    }
  }

  const sessionString = pendingClient.session.save();
  activeClient = pendingClient;
  pendingClient = null;
  pendingPhoneCodeHash = null;
  pendingPhone = null;

  await saveTelegramSettings({
    session_string: sessionString,
    connected: true,
    last_connected_at: new Date().toISOString(),
  });

  return { connected: true };
}

/** Returns a connected client using the saved session, reconnecting if needed. */
export async function getConnectedClient() {
  if (activeClient?.connected) return activeClient;

  const settings = await getTelegramSettings();
  if (!settings?.session_string) {
    throw new Error('Not connected yet. Send and verify the login code first.');
  }
  const client = newClient(settings.api_id, settings.api_hash, settings.session_string);
  await client.connect();
  activeClient = client;
  return client;
}

export async function logout() {
  try {
    const client = await getConnectedClient();
    await client.invoke(new Api.auth.LogOut());
    await client.disconnect();
  } catch {
    // ignore - we clear the stored session regardless
  }
  activeClient = null;
  pendingClient = null;
  pendingPhoneCodeHash = null;
  pendingPhone = null;
  await saveTelegramSettings({ session_string: '', connected: false });
}

export { Api };
