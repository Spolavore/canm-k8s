import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditLogEntry } from '@/types';

class AuditLogger {
    private filePath: string;

    constructor(filePath: string = './migrations.jsonl') {
        this.filePath = filePath;
        const dir = dirname(filePath);
        if (dir !== '.' && !existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    log(entry: AuditLogEntry): void {
        appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    }
}

export default AuditLogger;
