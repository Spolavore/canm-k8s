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

export type NodeScore = {
  node: string,
  score: number
}

export type ExpandedNodeScore = {
    node: string,
    score: number,
    nodePool: string | null
}

export type MigrationConfig = {
    lowScoreThreshold: number,
    highScoreThreshold: number,
}