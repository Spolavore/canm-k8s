export type ByteUnits = 'b' | 'kb' | 'mb' | 'gb'

export const convertionCoefficients = {
    'b': 1,
    'kb': 1024,
    'mb': Math.pow(1024, 2),
    'gb': Math.pow(1024, 3)
}

