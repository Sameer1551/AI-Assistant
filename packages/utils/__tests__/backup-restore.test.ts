import { describe, it, expect, vi } from 'vitest';
import { BackupRestoreManager } from '../src/backup-restore.js';

describe('BackupRestoreManager', () => {
  const mockSecrets = {
    encrypt: async (pt: string) => `enc:${pt}`,
    decrypt: async (ct: string) => ct.substring(4),
  };

  const mockAudit = {
    publishAudit: vi.fn(),
  };

  it('correctly secures, validates, and restores database backups', async () => {
    const manager = new BackupRestoreManager(mockSecrets, mockAudit);

    const rawState = JSON.stringify({ users: ['alice'], version: 2 });
    
    // 1. Create backup
    const backup = await manager.createBackup('memory', rawState);
    expect(backup.backupId).toBeDefined();
    expect(backup.type).toBe('memory');
    expect(backup.encryptedData).toContain('enc:');
    expect(backup.sha256Checksum).toBeDefined();

    // 2. Successful restore
    const restored = await manager.restoreBackup(backup);
    expect(restored).toBe(rawState);
    expect(mockAudit.publishAudit).toHaveBeenCalled();

    // 3. Failed restore on corrupted checksum
    const corruptedBackup = {
      ...backup,
      sha256Checksum: 'wrong_checksum',
    };

    await expect(manager.restoreBackup(corruptedBackup)).rejects.toThrow(/checksum mismatch/);
  });
});
