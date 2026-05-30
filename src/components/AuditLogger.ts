import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MigrationLogEntry, CompensationLogEntry, ReconciliationLogEntry } from '@/types';

class AuditLogger {
    private migrationFilePath: string;
    private compensationFilePath: string;
    private reconciliationFilePath: string;

    constructor(
        migrationFilePath: string = './migrations.jsonl',
        compensationFilePath: string = './compensations.jsonl',
        reconciliationFilePath: string = './reconciliations.jsonl',
    ) {
        this.migrationFilePath = migrationFilePath;
        this.compensationFilePath = compensationFilePath;
        this.reconciliationFilePath = reconciliationFilePath;
        for (const path of [migrationFilePath, compensationFilePath, reconciliationFilePath]) {
            const dir = dirname(path);
            if (dir !== '.' && !existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
        }
    }

    logMigration(entry: MigrationLogEntry): void {
        appendFileSync(this.migrationFilePath, JSON.stringify(entry) + '\n', 'utf-8');
    }

    logCompensation(entry: CompensationLogEntry): void {
        appendFileSync(this.compensationFilePath, JSON.stringify(entry) + '\n', 'utf-8');
    }

    logReconciliation(entry: ReconciliationLogEntry): void {
        appendFileSync(this.reconciliationFilePath, JSON.stringify(entry) + '\n', 'utf-8');
    }
}

export default AuditLogger;
