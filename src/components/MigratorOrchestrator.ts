import MetricsAdapter from '@components/MetricsAdapter';
import GkeNodeMigrator from '@components/GkeNodeMigrator';
import AuditLogger from '@components/AuditLogger';
import {
    AvailableProviders,
    ComparisonOperator,
    MigrationConfig,
    RawWeightsConfig,
    WeightsConfig,
    PipelineStage,
    CanmNodeState,
} from '@/types';
import { comp } from '@/utils/math';
import { ProviderConfig } from '@/lib/KubernetesClient';
import { exit } from 'process';
import type {
    KubernetesNodes,
    ClusterNodes,
    ExpandedNodeScore,
    MigrationDirection,
    MigrationPipelineResponse,
} from '@/types';
import { ANNOTATION, logger } from '@/utils';
import { convertToMs } from '@/utils/date';

const COMPONENT = 'Migrator Orchestrator';

class MigratorOrchestrator {
    private DEFAULT_CPU_WEIGHT = 0.6;
    private DEFAULT_MEMORY_WEIGHT = 0.3;

    private metrics: MetricsAdapter;
    private nodeMigrator!: GkeNodeMigrator;
    private auditLogger: AuditLogger;

    private migrationConfig: MigrationConfig;
    private provider: AvailableProviders;
    private weights: WeightsConfig;
    private showDecisionsLogs: boolean; // Debug env variable.

    constructor(
        migrationConfig: MigrationConfig,
        rawWeights: RawWeightsConfig,
        provider: AvailableProviders,
        providerConf: ProviderConfig,
    ) {
        this.migrationConfig = {
            policy: 'prioritizeCost',
            checkInterval: '1m',
            highNodeCoolDown: '30m',
            lowNodeCoolDown: '5m',
            lowPoolTimeWindowEval: '5m',
            highPoolTimeWindowEval: '30m',
            ...migrationConfig,
        };
        this.provider = provider;
        this.weights = {
            cpu: this.parseWeight(rawWeights.cpu, this.DEFAULT_CPU_WEIGHT),
            memory: this.parseWeight(rawWeights.memory, this.DEFAULT_MEMORY_WEIGHT),
        };
        this.metrics = new MetricsAdapter(this.weights);
        this.auditLogger = new AuditLogger();
        this.selectNodeMigrator(providerConf);
        if (!this.nodeMigrator) {
            logger(COMPONENT, 'No provider was found, exiting...', 'info');
            exit(1);
        }
        this.showDecisionsLogs = process.env.SHOW_DECISIONS_LOGS === 'TRUE';
    }

    private selectNodeMigrator(config: ProviderConfig) {
        switch (this.provider) {
            case 'gke':
                this.nodeMigrator = new GkeNodeMigrator(
                    config,
                    this.migrationConfig.highNodePool,
                    this.migrationConfig.lowNodePool,
                );
                break;
        }
    }
    private parseWeight(value: string | undefined, fallback: number): number {
        const parsed = parseFloat(value ?? '');
        return isNaN(parsed) ? fallback : parsed;
    }
    private async getNodesScore(timeWindow: string, nodePool?: string): Promise<ExpandedNodeScore[] | null> {
        const nodesScore = await this.metrics.getNodesScore(timeWindow);
        if (!nodesScore || nodesScore.length === 0) return null;

        const expanded = this.nodeMigrator.expandNodesInfo(nodesScore);

        if (nodePool === 'low') return expanded.filter((n) => n.nodePool === this.migrationConfig.lowNodePool);
        if (nodePool === 'high') return expanded.filter((n) => n.nodePool === this.migrationConfig.highNodePool);
        return expanded;
    }

    private isNodeInCooldown(node: ExpandedNodeScore): boolean {
        let cooldown: number;

        if (node.nodePool === this.migrationConfig.lowNodePool) {
            cooldown = convertToMs(this.migrationConfig.lowNodeCoolDown!);
        } else {
            cooldown = convertToMs(this.migrationConfig.highNodeCoolDown!);
        }

        return Date.now() - new Date(node.creationTimestamp).getTime() < cooldown;
    }

    private evaluateNodePool(nodesScore: ExpandedNodeScore[], threshold: number, cmp: ComparisonOperator) {
        let actionEffectuated = false;
        for (const node of nodesScore) {
            if (this.isNodeInCooldown(node)) {
                logger(
                    COMPONENT,
                    `Node ${node.node} of ${node.nodePool} is in cooldown, created at: ${node.creationTimestamp}`,
                    'info',
                    this.showDecisionsLogs,
                );
                continue;
            }
            if (comp(node.score, threshold, cmp)) {
                logger(
                    COMPONENT,
                    `Node ${node.node} is a candidate to be migrated to ${node.nodePool === this.migrationConfig.lowNodePool ? 'high node pool' : 'low node pool'} with ${node.score} score `,
                    'info',
                    this.showDecisionsLogs,
                );
                this.migrateNode(node);
                actionEffectuated = true;
                break;
            }

            logger(
                COMPONENT,
                `Node ${node.node} didn't achieved the necessary score to migrate to ${node.nodePool === this.migrationConfig.lowNodePool ? 'high node pool' : 'low node pool'} with ${node.score} score `,
                'info',
                this.showDecisionsLogs,
            );
        }

        return actionEffectuated;
    }

    private compensate(
        direction: MigrationDirection,
        stage: PipelineStage,
        currentNode: ExpandedNodeScore,
        nodeCreated?: string,
    ) {
        logger(COMPONENT, `Iniciating compensating process for stage: ${stage}`);
        switch (stage) {
            case 'addition':
                try {
                    this.nodeMigrator.removeNodeAnnotation(currentNode.node, 'MIGRATION_STAGE');
                } catch (error) {
                    logger(
                        COMPONENT,
                        `Couldn't remove addition anotation from node ${currentNode.node}, error: ${error}`,
                    );
                    return;
                }
                break;
            case 'draining':
                if (!nodeCreated) {
                    logger(COMPONENT, `Cannot compensate draining without nodeCreated reference`, 'error');
                    return;
                }
                try {
                    this.nodeMigrator.uncordon(currentNode.node);
                } catch (error) {
                    logger(
                        COMPONENT,
                        `Couldn't uncordon source node ${currentNode.node} during draining compensation: ${error}. Node will remain cordoned until next reconciliation tick.`,
                        'error',
                    );
                }
                try {
                    direction === 'high->low'
                        ? this.nodeMigrator.removeNodeLowNodePool(nodeCreated)
                        : this.nodeMigrator.removeNodeHighNodePool(nodeCreated);
                } catch (error) {
                    logger(
                        COMPONENT,
                        `Couldn't compensate draining failure: removal of orphan node ${nodeCreated} (direction ${direction}, source ${currentNode.node}) failed: ${error}. Marking ${nodeCreated} as pending-removal for next reconciliation tick.`,
                        'error',
                    );
                    this.nodeMigrator.annotateNode(nodeCreated, 'STATE', 'pending-removal');
                }
                break;
            case 'removing':
                // No action: source already has MIGRATION_STAGE=removing from pipeline,
                // which lets reconciliation pick it up via case C and retry the removal.
                logger(COMPONENT, `Removing failure: delegating retry to reconciliation`);
                break;

            default:
                logger(COMPONENT, `No action implemented for ${stage} compensate proccess`);
                return;
        }
    }

    private executeMigrationPipeline(
        node: ExpandedNodeScore,
        direction: MigrationDirection,
    ): MigrationPipelineResponse {
        let newNode: string | null;
        // Adding node to the other node pool
        try {
            this.nodeMigrator.annotateNode(node.node, 'MIGRATION_STAGE', 'addition');
            newNode =
                direction == 'high->low'
                    ? this.nodeMigrator.addNodeLowNodePool()
                    : this.nodeMigrator.addNodeHighNodePool();
            this.nodeMigrator.annotateNode(newNode!, 'STATE', 'created');
            this.nodeMigrator.annotateNode(newNode!, 'SOURCE_NODE', node.node);
        } catch (error) {
            this.compensate(direction, 'addition', node);
            logger(COMPONENT, `Error on adding node: ${error}`);
            return { status: 'failed', stage: 'addition' };
        }
        // Draining the current node - letting the pods to be reeschedule in the created node
        try {
            this.nodeMigrator.annotateNode(node.node, 'MIGRATION_STAGE', 'draining');
            this.nodeMigrator.drain(node.node, 60, true);
        } catch (error) {
            logger(COMPONENT, `Error on draining node ${node.node}: ${error}`);
            this.compensate(direction, 'draining', node, newNode!);
            return { status: 'failed', stage: 'draining' };
        }

        // Removing the drained node.
        try {
            this.nodeMigrator.annotateNode(node.node, 'MIGRATION_STAGE', 'removing');
            direction == 'high->low'
                ? this.nodeMigrator.removeNodeHighNodePool(node.node)
                : this.nodeMigrator.removeNodeLowNodePool(node.node);
        } catch (error) {
            logger(COMPONENT, `Error on removing node ${node.node}: ${error}`);
            this.compensate(direction, 'removing', node);
            return { status: 'failed', stage: 'removing' };
        }

        this.nodeMigrator.annotateNode(newNode!, 'STATE', 'managed');
        return { status: 'passed', stage: 'conclued' };
    }

    private migrateNode(node: ExpandedNodeScore) {
        const nodePoolTo =
            node.nodePool === this.migrationConfig.lowNodePool
                ? this.migrationConfig.highNodePool
                : this.migrationConfig.lowNodePool;
        const direction: MigrationDirection =
            nodePoolTo === this.migrationConfig.lowNodePool ? 'high->low' : 'low->high';
        logger(COMPONENT, `Migrating ${node.node} with score ${node.score.toFixed(2)} to ${nodePoolTo}`);
        const start = Date.now();
        const pipelineRes: MigrationPipelineResponse = this.executeMigrationPipeline(node, direction);
        const durationMs = Date.now() - start;
        if (pipelineRes.status === 'passed') {
            logger(COMPONENT, `Migration finished in ${(durationMs / 1000).toFixed(1)}s`);
        } else {
            logger(COMPONENT, `Migration of ${node.node} failed after ${(durationMs / 1000).toFixed(1)}s`, 'error');
        }
        this.auditLogger.log({
            timestamp: new Date(start).toISOString(),
            durationMs,
            direction,
            node: node.node,
            score: node.score,
            fromPool: node.nodePool,
            toPool: nodePoolTo,
            policy: this.migrationConfig.policy!,
            status: pipelineRes.status,
        });
    }

    private sortByScore(nodes: ExpandedNodeScore[], order: 'asc' | 'desc'): ExpandedNodeScore[] {
        const direction = order === 'asc' ? 1 : -1;
        return [...nodes].sort((a, b) => direction * (a.score - b.score));
    }

    private async evaluateCluster(): Promise<any> {
        logger(COMPONENT, `Iniciating cluster evaluation ${new Date().toISOString()}`);

        const [nodesScoreLowNodePool, nodesScoreHighNodePool] = await Promise.all([
            this.getNodesScore(this.migrationConfig.lowPoolTimeWindowEval!, 'low'),
            this.getNodesScore(this.migrationConfig.highPoolTimeWindowEval!, 'high'),
        ]).then(([low, high]) => [low ? this.sortByScore(low, 'desc') : [], high ? this.sortByScore(high, 'asc') : []]);

        if (nodesScoreLowNodePool.length === 0 && nodesScoreHighNodePool.length === 0) return;

        let hasChanged = false;
        switch (this.migrationConfig.policy) {
            case 'prioritizePerformance': {
                hasChanged = this.evaluateNodePool(
                    nodesScoreLowNodePool,
                    this.migrationConfig.highScoreThreshold,
                    'gte',
                );
                if (hasChanged) return;
                hasChanged = this.evaluateNodePool(
                    nodesScoreHighNodePool,
                    this.migrationConfig.lowScoreThreshold,
                    'lte',
                );
                break;
            }

            case 'prioritizeCost': {
                hasChanged = this.evaluateNodePool(
                    nodesScoreHighNodePool,
                    this.migrationConfig.lowScoreThreshold,
                    'lte',
                );
                if (hasChanged) return;
                hasChanged = this.evaluateNodePool(
                    nodesScoreLowNodePool,
                    this.migrationConfig.highScoreThreshold,
                    'gte',
                );
                break;
            }
        }

        if (!hasChanged) {
            logger(COMPONENT, 'No action was effected on this cicle');
        }
    }

    private getUnreconciledNodes(clusterNodes: ClusterNodes): KubernetesNodes[] {
        const canmCreatedNodes = clusterNodes.createdByCanm;
        const providerNodes = clusterNodes.createdByProvider;
        // LAST_RECONCILIATION is diagnostic metadata, not a reconciliation trigger.
        // A provider node carrying only LAST_RECONCILIATION is considered clean.
        const triggerKeys: string[] = Object.values(ANNOTATION).filter((k) => k !== ANNOTATION.LAST_RECONCILIATION);
        // First evaluate the more expensive nodes, which have greater impact on the total Cost.
        return [
            ...canmCreatedNodes.filter((node) => {
                const annotations = node.annotations;
                return annotations[ANNOTATION.STATE] !== 'managed' || annotations[ANNOTATION.MIGRATION_STAGE] != null;
            }),
            ...providerNodes.filter((node) => Object.keys(node.annotations).some((a) => triggerKeys.includes(a))),
        ].sort(
            (a, b) =>
                Number(b.nodePool == this.migrationConfig.highNodePool) -
                Number(a.nodePool == this.migrationConfig.highNodePool),
        );
    }

    private async reconcilePendingMigrations(): Promise<boolean> {
        logger(COMPONENT, `Iniciating the reconciliation of pending migrations ${new Date().toISOString()}`);

        const RECONCILIATION_COOLDOWN_MS = 5 * 60 * 1000;
        let heavyActionExecuted = false;

        try {
            const clusterNodes = await this.nodeMigrator.getClusterNodes();
            const unreconciledNodes = this.getUnreconciledNodes(clusterNodes);
            if (unreconciledNodes.length === 0) {
                logger(COMPONENT, `No unreconciled nodes found, skipping to cluster evaluation...`);
                return true;
            }
            const canmAnnotationKeys: string[] = Object.values(ANNOTATION);

            const isInCooldown = (node: KubernetesNodes): boolean => {
                const last = node.annotations[ANNOTATION.LAST_RECONCILIATION];
                if (last == null) return false;
                const lastTs = new Date(last).getTime();
                if (Number.isNaN(lastTs)) return false;
                return Date.now() - lastTs < RECONCILIATION_COOLDOWN_MS;
            };

            const markReconciled = (node: KubernetesNodes) => {
                this.nodeMigrator.annotateNode(node.name, 'LAST_RECONCILIATION', new Date().toISOString());
            };

            const removeFromPool = (node: KubernetesNodes): boolean => {
                try {
                    node.nodePool === this.migrationConfig.highNodePool
                        ? this.nodeMigrator.removeNodeHighNodePool(node.name)
                        : this.nodeMigrator.removeNodeLowNodePool(node.name);
                    return true;
                } catch (error) {
                    logger(COMPONENT, `Reconcile: failed to remove ${node.name}: ${error}`, 'error');
                    return false;
                }
            };

            for (const node of unreconciledNodes) {
                if (isInCooldown(node)) continue;

                const state = node.annotations[ANNOTATION.STATE] as CanmNodeState | undefined;
                const stage = node.annotations[ANNOTATION.MIGRATION_STAGE] as PipelineStage | undefined;
                const hasAnyCanmAnnotation = Object.keys(node.annotations).some((a) => canmAnnotationKeys.includes(a));

                // CASE A: orphan CANM node (no CANM annotations) — HEAVY
                // Only triggers for canm-prefixed nodes; provider nodes are pre-filtered to have at least one.
                if (!hasAnyCanmAnnotation) {
                    if (heavyActionExecuted) continue;
                    logger(COMPONENT, `Unmapped CANM node ${node.name}, deleting`);
                    const ok = removeFromPool(node);
                    heavyActionExecuted = true;
                    if (!ok) markReconciled(node);
                    continue;
                }

                // CASE B: canm node in non-terminal STATE — HEAVY
                // Live K8s lookup (not snapshot) to avoid races where the source was deleted
                // earlier in this same tick. Missing SOURCE_NODE annotation defaults to "exists"
                // (conservative: keeps the old delete behavior instead of falsely promoting).
                const sourceNodeName = node.annotations[ANNOTATION.SOURCE_NODE];
                let sourceExists = true;
                let sourceNode = null;
                if (sourceNodeName) {
                    sourceNode = await this.nodeMigrator.getNodeByName(sourceNodeName);
                    sourceExists = sourceNode !== null;
                }

                if (
                    state === 'created' &&
                    (!sourceExists || sourceNode?.annotations[ANNOTATION.MIGRATION_STAGE] == 'removing')
                ) {
                    logger(
                        COMPONENT,
                        `Node ${node.name} was already migrated, the source was deleted: updating node state to managed`,
                    );
                    this.nodeMigrator.annotateNode(node.name, 'STATE', 'managed');
                    continue;
                } else if (state == 'created' || state === 'pending-removal') {
                    if (heavyActionExecuted) continue;
                    logger(COMPONENT, `CANM node ${node.name} (state=${state}) is orphan, deleting`);
                    const ok = removeFromPool(node);
                    heavyActionExecuted = true;
                    if (!ok) markReconciled(node);
                    continue;
                }

                // CASE C: source stuck mid-pipeline — dispatch on STAGE
                switch (stage) {
                    case 'addition': {
                        // METADATA: clear stale annotation
                        logger(COMPONENT, `Source ${node.name} stuck at addition, clearing stage`);
                        const ok = this.nodeMigrator.removeNodeAnnotation(node.name, 'MIGRATION_STAGE');
                        if (!ok) markReconciled(node);
                        break;
                    }
                    case 'draining': {
                        // METADATA: uncordon source (if cordoned); only clear stage on uncordon success
                        // so the node stays visible to reconcile if uncordon failed.
                        logger(COMPONENT, `Source ${node.name} stuck at draining, uncordoning`);
                        let uncordonOk = true;
                        try {
                            if (this.nodeMigrator.isNodeCordoned(node.name)) {
                                this.nodeMigrator.uncordon(node.name);
                            }
                        } catch (error) {
                            uncordonOk = false;
                            logger(COMPONENT, `Reconcile: uncordon failed for ${node.name}: ${error}`, 'error');
                        }

                        if (!uncordonOk) {
                            markReconciled(node);
                            break;
                        }

                        const cleanOk = this.nodeMigrator.removeNodeAnnotation(node.name, 'MIGRATION_STAGE');
                        if (!cleanOk) markReconciled(node);
                        break;
                    }
                    case 'removing': {
                        // HEAVY: retry the source removal
                        if (heavyActionExecuted) continue;
                        logger(COMPONENT, `Source ${node.name} stuck at removing, retrying`);
                        const ok = removeFromPool(node);
                        heavyActionExecuted = true;
                        if (!ok) markReconciled(node);
                        break;
                    }
                    default: {
                        logger(COMPONENT, `No reconciliation action for ${node.name} (state=${state}, stage=${stage})`);
                    }
                }
            }

            // Allow evaluateCluster to run unless we did something destructive this tick.
            return !heavyActionExecuted;
        } catch (error) {
            logger(COMPONENT, `Error on the reconciliation proccess: ${error}`, 'error');
            return false;
        }
    }

    async start() {
        logger(
            COMPONENT,
            `\nConfig:\nLow threshold: ${this.migrationConfig.lowScoreThreshold}\nLow cooldown: ${this.migrationConfig.lowNodeCoolDown}\nHigh threshold: ${this.migrationConfig.highScoreThreshold}\nHigh cooldown: ${this.migrationConfig.highNodeCoolDown}\nPolicy: ${this.migrationConfig.policy}`,
            'info',
            this.showDecisionsLogs,
        );
        const tick = async () => {
            try {
                const canEvaluateCluster = await this.reconcilePendingMigrations();
                if (canEvaluateCluster) {
                    await this.evaluateCluster();
                } else {
                    logger(
                        COMPONENT,
                        `The reconciliation step made changes to the state of the cluster, skipping evaluation...`,
                    );
                }
            } catch (err) {
                logger(COMPONENT, `Unexpected error during cluster evaluation: ${err}`, 'error');
            }
            setTimeout(tick, convertToMs(this.migrationConfig.checkInterval!));
        };
        await tick();
    }
}

export default MigratorOrchestrator;
