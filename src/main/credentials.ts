/**
 * Saved database passwords. They are encrypted with Electron's safeStorage, which uses the
 * operating system's protection (Windows DPAPI, the macOS Keychain, or the Linux Secret Service),
 * and kept in credentials.json in the app's settings folder, filed under a connection id.
 * They are never written to project files. On Linux without a keyring, safeStorage would fall back
 * to a fixed key, so passwords are not saved there and the app asks for them instead.
 */
import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeChunks } from './write';

const file = (): string => join(app.getPath('userData'), 'credentials.json');

export function canSavePasswords(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

async function readAll(): Promise<Record<string, string>> {
  try {
    const data = JSON.parse(await fs.readFile(file(), 'utf8')) as unknown;
    return data && typeof data === 'object' ? (data as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function writeAll(all: Record<string, string>): Promise<void> {
  const tmp = `${file()}.tmp`;
  await writeChunks(tmp, [JSON.stringify(all, null, 2)]);
  await fs.rename(tmp, file());
}

export async function savePassword(connectionId: string, password: string): Promise<void> {
  if (!canSavePasswords()) return;
  const all = await readAll();
  all[connectionId] = safeStorage.encryptString(password).toString('base64');
  await writeAll(all);
}

export async function loadPassword(connectionId: string): Promise<string | undefined> {
  const stored = (await readAll())[connectionId];
  if (!stored || !canSavePasswords()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    // Encrypted by another user account or machine.
    return undefined;
  }
}

export async function forgetPassword(connectionId: string): Promise<void> {
  const all = await readAll();
  if (!(connectionId in all)) return;
  delete all[connectionId];
  await writeAll(all);
}
