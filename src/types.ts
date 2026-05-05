export type AvailableProviders = 'gke' | null;

export type RawWeightsConfig = {
    cpu?: string;
    memory?: string;
    network?: string;
};

export type WeightsConfig = {
    cpu: number;
    memory: number;
    network: number;
};

export type MigrationConfig = {
    scoreThreshold: number
}