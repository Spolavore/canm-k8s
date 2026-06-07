import { ComparisonOperator } from "@/types";

export function normalize(values: number[]): number[] {
    const sum = values.reduce((acc, v) => acc + v, 0);
    if (sum === 0) return values.map(() => 0);
    return values.map(v => v / sum);
}

export function chunk<T>(items: T[], size: number): T[][] {
    if (size <= 0) return [items];
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        batches.push(items.slice(i, i + size));
    }
    return batches;
}

export const comp = (a: number, b: number, cmp: ComparisonOperator): boolean => ({
    eq:  () => a === b,
    gt:  () => a > b,
    gte: () => a >= b,
    lt:  () => a < b,
    lte: () => a <= b,
} as Record<ComparisonOperator, () => boolean>)[cmp]();
