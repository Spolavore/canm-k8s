export function normalize(values: number[]): number[] {
    const sum = values.reduce((acc, v) => acc + v, 0);
    if (sum === 0) return values.map(() => 0);
    return values.map(v => v / sum);
}
