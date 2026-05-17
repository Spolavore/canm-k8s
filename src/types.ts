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
    node: string;
    score: number;
};

export type ExpandedNodeScore = {
    node: string;
    score: number;
    nodePool: string;
    creationTimestamp: string;
};

export type KubernetesNodes = {
    name: string;
    creationTimestamp: string | null;
    annotations: Record<string, string>;
    labels: Record<string, string>;
    nodePool?: string;
};

export type ClusterNodes = {
    createdByCanm: KubernetesNodes[];
    createdByProvider: KubernetesNodes[];
};

export type MigrationConfig = {
    highNodePool: string;
    lowNodePool: string;
    lowScoreThreshold: number;
    highScoreThreshold: number;
    policy?: MigrationPolicies;
    checkInterval?: string;
    highNodeCoolDown?: string;
    lowNodeCoolDown?: string;
    lowPoolTimeWindowEval?: string;
    highPoolTimeWindowEval?: string;
};

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
};

// Which pipeline step a migration was on — used in MigrationPipelineResponse and compensate(stage)
export type PipelineStage = 'addition' | 'draining' | 'removing' | 'conclued';

// Value of the canm.io/state annotation on the node — describes the node's current logical condition
export type CanmNodeState = 'created' | 'managed' | 'pending-removal';

type MigrationStatus = 'passed' | 'failed';

export type MigrationPipelineResponse = {
    status: MigrationStatus;
    stage: PipelineStage;
};
