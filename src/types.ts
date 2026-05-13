export type AvailableProviders = 'gke' | null;
export type ComparisonOperator = 'eq' | 'gt' | 'gte' | 'lt' | 'lte';
export type MigrationPolicies = 'prioritizeCost' | 'prioritizePerformance';

export type RawWeightsConfig = {
    cpu?: string;
    memory?: string;
};

export type WeightsConfig = {
    cpu: number;
    memory: number;
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

export type MigrationDirection = 'high->low' | 'low->high';

export type AuditLogEntry = {
    timestamp: string;
    duration_ms: number;
    direction: MigrationDirection;
    node: string;
    score: number;
    from_pool: string;
    to_pool: string;
    policy: MigrationPolicies;
    success: boolean;
}