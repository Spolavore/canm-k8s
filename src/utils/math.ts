import { ComparisonOperator } from "@/types";

export function normalize(values: number[]): number[] {
    const sum = values.reduce((acc, v) => acc + v, 0);
    if (sum === 0) return values.map(() => 0);
    return values.map(v => v / sum);
}

export const comp = (a: number, b: number, cmp: ComparisonOperator): boolean => ({
    eq:  () => a === b,
    gt:  () => a > b,
    gte: () => a >= b,
    lt:  () => a < b,
    lte: () => a <= b,
} as Record<ComparisonOperator, () => boolean>)[cmp]();
