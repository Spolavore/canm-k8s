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
    drainPaced?: boolean;
    drainBatchTimeout?: string;
    drainBatchSize?: number;
    removeSettle?: string;
};

export type MigrationDirection = 'high->low' | 'low->high';

// Marcos (ISO) de cada estágio do pipeline — usados para correlacionar erros do
// teste de carga (ex: blackhole de ~120s) com o instante exato de cada ação
// (notadamente removeStart = quando o delete-instances dispara).
export type StageTimings = {
    additionStart?: string;
    additionEnd?: string;
    drainStart?: string;
    drainEnd?: string;
    removeStart?: string;
    vmDeleteStart?: string;
    removeEnd?: string;
};

export type MigrationLogEntry = {
    timestamp: string;
    durationMs: number;
    direction: MigrationDirection;
    node: string;
    score: number;
    fromPool: string;
    toPool: string;
    policy: MigrationPolicies;
    status: MigrationStatus;
    stages?: StageTimings;
};

export type CompensationLogEntry = {
    timestamp: string;
    sourceNode: string;
    destinationNode?: string;
    direction: MigrationDirection;
    failedStage: PipelineStage;
    action: CompensationAction;
    outcome: 'success' | 'failed';
};

type CompensationAction =
    | 'annotation_cleared'
    | 'uncordoned_dest_deleted'
    | 'dest_marked_pending_removal'
    | 'delegated_to_reconciliation';

export type ReconciliationLogEntry = {
    timestamp: string;
    node: string;
    nodeState?: CanmNodeState;
    pipelineStage?: PipelineStage;
    action: ReconciliationAction;
    outcome: 'success' | 'failed';
};

type ReconciliationAction = 'deleted' | 'promoted_to_managed' | 'stage_cleared' | 'retry_removal';

// Which pipeline step a migration was on — used in MigrationPipelineResponse and compensate(stage)
export type PipelineStage = 'addition' | 'draining' | 'removing' | 'conclued';

// Value of the canm.io/state annotation on the node — describes the node's current logical condition
export type CanmNodeState = 'created' | 'managed' | 'pending-removal';

type MigrationStatus = 'passed' | 'failed';

export type MigrationPipelineResponse = {
    status: MigrationStatus;
    stage: PipelineStage;
    stages?: StageTimings;
};
