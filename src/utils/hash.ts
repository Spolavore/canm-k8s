import { randomBytes } from 'node:crypto';

export function generateHash(length: number): string {
    return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}
