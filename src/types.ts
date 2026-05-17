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

export type K8sNodeInfo = {
    name: string,
    creationTimestamp: string | null,
    annotations: Record<string, string>,
    labels: Record<string, string>,
}

export type CanmManagedNode = {
    name: string,
    creationTimestamp: string | null,
    annotations: Record<string, string>,
    nodePool: string,
}

export type MigrationConfig = {
    highNodePool: string,
    lowNodePool: string,
    lowScoreThreshold: number,
    highScoreThreshold: number,
    policy?: MigrationPolicies,
    checkInterval?: string,
    highNodeCoolDown?: string,
    lowNodeCoolDown?: string,
    lowPoolTimeWindowEval?: string,
    highPoolTimeWindowEval?: string,
}

export type MigrationDirection = 'high->low' | 'low->high';

export type AuditLogEntry = {
    timestamp: string;
    durationMs: number;
    direction: MigrationDirection;
    node: string;
    score: number;
    fromPool: string;
    toPool: string;
    policy: MigrationPolicies;
    status: MigrationStatus;
}

export type MigrationStages = 'addition' | 'draining' | 'removing' | 'conclued';

type MigrationStatus = 'passed' | 'failed'

export type MigrationPipelineResponse = {
    status: MigrationStatus ,
    stage:  MigrationStages
}