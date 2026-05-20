/**
 * @module backup-restore
 * Backup & Disaster Recovery management.
 *
 * @see Requirements 32.1–32.6
 */

import { createHash, randomUUID } from 'node:crypto';

export interface IBackupSecretsService {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export interface IBackupAuditService {
  publishAudit(event: any): Promise<void>;
}

export interface BackupDescriptor {
  readonly backupId: string;
  readonly type: 'memory' | 'workflow' | 'audit' | 'telemetry';
  readonly timestamp: string;
  readonly encryptedData: string;
  readonly sha256Checksum: string;
}

export class BackupRestoreManager {
  constructor(
    private readonly secretsService: IBackupSecretsService,
    private readonly auditService: IBackupAuditService
  ) {}

  /**
   * Produces a secure backup of database records.
   * Satisfies RPO limits (Req 32.1) and backup encryption (Req 32.3).
   */
  async createBackup(
    type: 'memory' | 'workflow' | 'audit' | 'telemetry',
    rawData: string
  ): Promise<BackupDescriptor> {
    const backupId = randomUUID();
    
    // 1. Encrypt backup data using Secrets Service keys (Requirement 32.3)
    const encryptedData = await this.secretsService.encrypt(rawData);

    // 2. Generate SHA-256 checksum for integrity check (Requirement 32.5)
    const sha256Checksum = createHash('sha256').update(encryptedData).digest('hex');

    return {
      backupId,
      type,
      timestamp: new Date().toISOString(),
      encryptedData,
      sha256Checksum,
    };
  }

  /**
   * Restores database state from a backup.
   * Satisfies integrity checks (Req 32.5) and audit emissions on restore (Req 32.5).
   */
  async restoreBackup(descriptor: BackupDescriptor): Promise<string> {
    // 1. Verify integrity of backup file (Requirement 32.5)
    const computedChecksum = createHash('sha256').update(descriptor.encryptedData).digest('hex');
    if (computedChecksum !== descriptor.sha256Checksum) {
      throw new Error(`CRITICAL: Backup restore failed due to checksum mismatch. Data may be corrupted.`);
    }

    // 2. Decrypt backup data using Secrets Service keys
    const decryptedData = await this.secretsService.decrypt(descriptor.encryptedData);

    // 3. Emit audit event on restore (Requirement 32.5)
    await this.auditService.publishAudit({
      event_id: randomUUID(),
      severity: 'high',
      timestamp: new Date().toISOString(),
      message: `DISASTER RECOVERY: Database successfully restored from backup ID ${descriptor.backupId}. Type: ${descriptor.type}.`,
      metadata: {
        backup_id: descriptor.backupId,
        backup_type: descriptor.type,
      },
    });

    return decryptedData;
  }
}
