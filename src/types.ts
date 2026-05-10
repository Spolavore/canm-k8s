export type AvailableProviders = 'gke' | null;
export type ComparisonOperator = 'eq' | 'gt' | 'gte' | 'lt' | 'lte';
export type MigrationPolicies = 'prioritizeCost' | 'prioritizePerfomance';

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
    nodePool: string,
    creationTimestamp: string
}

export type MigrationConfig = {
    highNodePool: string,
    lowNodePool: string,
    lowScoreThreshold: number,
    highScoreThreshold: number,
    policy?: MigrationPolicies,
    checkInterval?: string,
    highNodeCoolDown?: string,
    lowNodeCoolDown?: string
}