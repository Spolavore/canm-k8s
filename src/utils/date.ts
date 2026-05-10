
const TIME_SUFFIXES = ['ms', 's', 'm', 'h'] as const;
export type TimeSuffix = typeof TIME_SUFFIXES[number];

const timeSuffixMultipliers: Record<TimeSuffix, number> = {
    'ms': 1,
    's': 1000,
    'm': 1000 * 60,
    'h': 1000 * 60 * 60,
};

export function convertToMs(time: string): number {
    for (const suffix of TIME_SUFFIXES) {
        if (!time.endsWith(suffix)) continue;
        const numeric = Number(time.slice(0, -suffix.length));
        if (Number.isNaN(numeric)) break;
        return numeric * timeSuffixMultipliers[suffix];
    }
    throw new Error(`${time} is a invalid time format.`);
}