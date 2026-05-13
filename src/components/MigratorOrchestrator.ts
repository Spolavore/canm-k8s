import MetricsAdapter from "@components/MetricsAdapter";
import GkeNodeMigrator from "@components/GkeNodeMigrator";
import AuditLogger from "@components/AuditLogger";
import { AvailableProviders, ComparisonOperator, MigrationConfig, RawWeightsConfig, WeightsConfig } from "@/types";
import { comp } from "@/utils/math";
import { ProviderConfig } from "@/lib/KubernetesClient";
import { exit } from "process";
import type { ExpandedNodeScore, MigrationDirection } from "@/types";
import { logger } from "@/utils";
import { convertToMs } from "@/utils/date";

const COMPONENT = "Migrator Orchestrator";

class MigratorOrchestrator {

    private DEFAULT_CPU_WEIGHT = 0.60;
    private DEFAULT_MEMORY_WEIGHT = 0.3;

    private metrics: MetricsAdapter;
    private nodeMigrator!: GkeNodeMigrator;
    private auditLogger: AuditLogger;

    private migrationConfig: MigrationConfig;
    private provider: AvailableProviders;
    private weights: WeightsConfig;


    constructor(migrationConfig: MigrationConfig, rawWeights: RawWeightsConfig, provider: AvailableProviders, providerConf: ProviderConfig){
        this.migrationConfig = {
            policy: 'prioritizeCost',
            checkInterval: '1m',
            highNodeCoolDown: '30m',
            lowNodeCoolDown: '5m',
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
        if(!this.nodeMigrator){
            logger(COMPONENT, "No provider was found, exiting...", 'info');
            exit(1)
        }
    }
    
    private selectNodeMigrator (config: ProviderConfig) {
        switch(this.provider){
            case 'gke':
                this.nodeMigrator = new GkeNodeMigrator(config, this.migrationConfig.highNodePool, this.migrationConfig.lowNodePool);
                break
        }
    }
    private parseWeight (value: string | undefined, fallback: number): number {
        const parsed = parseFloat(value ?? '');
        return isNaN(parsed) ? fallback : parsed;
    };
    private async getNodesScore(timeWindow: string, nodePool?: string): Promise<ExpandedNodeScore[] | null> {
        const nodesScore = await this.metrics.getNodesScore(timeWindow);
        if(!nodesScore || nodesScore.length === 0) return null;

        const expanded = this.nodeMigrator.expandNodesInfo(nodesScore);

        if(nodePool === 'low') return expanded.filter(n => n.nodePool === this.migrationConfig.lowNodePool);
        if(nodePool === 'high') return expanded.filter(n => n.nodePool === this.migrationConfig.highNodePool);
        return expanded;
    }

    private isNodeInCooldown(node: ExpandedNodeScore): boolean {
        let cooldown = 0;

        if(node.nodePool === this.migrationConfig.lowNodePool){
            cooldown = convertToMs(this.migrationConfig.lowNodeCoolDown!);
        }
        else {
            cooldown = convertToMs(this.migrationConfig.highNodeCoolDown!);
        }

        return (Date.now() - new Date(node.creationTimestamp).getTime())  < cooldown;
    }

    private evaluateNodePool(nodesScore: ExpandedNodeScore[], threshold: number, cmp: ComparisonOperator){
        let actionEffectuated = false;
        for(const node of nodesScore){
            if(this.isNodeInCooldown(node)){
                logger(COMPONENT, `${node.node} of ${node.nodePool} is in cooldown: ${node.creationTimestamp}`)
                continue;
            }
            if(comp(node.score, threshold, cmp)){
                this.migrateNode(node);
                actionEffectuated = true;
                break;
            };
        }

        return actionEffectuated;
    }
    private migrateNode(node: ExpandedNodeScore){
        const nodePoolTo = node.nodePool === this.migrationConfig.lowNodePool ? this.migrationConfig.highNodePool : this.migrationConfig.lowNodePool;
        const direction: MigrationDirection = nodePoolTo === this.migrationConfig.lowNodePool ? 'high->low' : 'low->high';
        logger(COMPONENT, `Migrating ${node.node} with score ${node.score.toFixed(2)} to ${nodePoolTo}`);
        const start = Date.now();
        let success = false;
        switch(nodePoolTo){
            case this.migrationConfig.lowNodePool:
                success = this.nodeMigrator.addNodeLowNodePool()
                    && this.nodeMigrator.drain(node.node, 60, true)
                    && this.nodeMigrator.removeNodeHighNodePool(node.node);
                break;

            case this.migrationConfig.highNodePool:
                success = this.nodeMigrator.addNodeHighNodePool()
                    && this.nodeMigrator.drain(node.node, 60, true)
                    && this.nodeMigrator.removeNodeLowNodePool(node.node);
                break;
        }
        const duration_ms = Date.now() - start;
        if(success){
            logger(COMPONENT, `Migration finished in ${(duration_ms / 1000).toFixed(1)}s`);
        } else {
            logger(COMPONENT, `Migration of ${node.node} failed after ${(duration_ms / 1000).toFixed(1)}s`, 'error');
        }
        this.auditLogger.log({
            timestamp: new Date(start).toISOString(),
            duration_ms,
            direction,
            node: node.node,
            score: node.score,
            from_pool: node.nodePool,
            to_pool: nodePoolTo,
            policy: this.migrationConfig.policy!,
            success,
        });
    }

    private sortByScore(nodes: ExpandedNodeScore[], order: 'asc' | 'desc'): ExpandedNodeScore[] {
        const direction = order === 'asc' ? 1 : -1;
        return [...nodes].sort((a, b) => direction * (a.score - b.score));
    }

    private async evaluateCluster(): Promise<any>{
        logger(COMPONENT, `Iniciating cluster evaluation ${new Date().toISOString()}`);

        const [nodesScoreLowNodePool, nodesScoreHighNodePool] = await Promise.all([
            this.getNodesScore('10m', 'low'),
            this.getNodesScore('1h', 'high'),
        ]).then(([low, high]) => [
            low ? this.sortByScore(low, 'desc') : [],
            high ? this.sortByScore(high, 'asc') : [],
        ]);

        if(nodesScoreLowNodePool.length === 0 && nodesScoreHighNodePool.length === 0) return;
        
        
        let hasChanged = false;
        switch(this.migrationConfig.policy){
            case 'prioritizePerformance': {
                hasChanged = this.evaluateNodePool(nodesScoreLowNodePool, this.migrationConfig.highScoreThreshold, 'gte');
                if(hasChanged) return;
                this.evaluateNodePool(nodesScoreHighNodePool, this.migrationConfig.lowScoreThreshold, 'lte');
                break;
            }
                
            case 'prioritizeCost': {
                hasChanged = this.evaluateNodePool(nodesScoreHighNodePool, this.migrationConfig.lowScoreThreshold, 'lte');
                if(hasChanged) return;
                this.evaluateNodePool(nodesScoreLowNodePool, this.migrationConfig.highScoreThreshold, 'gte');
               break;                
            }        
        }
        
        if(!hasChanged) {
            logger(COMPONENT, 'No action was effected on this cicle');
        }
    }

    async start() {
        const tick = async () => {
            try {
                await this.evaluateCluster();
            } catch(err) {
                logger(COMPONENT, `Unexpected error during cluster evaluation: ${err}`, 'error');
            }
            setTimeout(tick, convertToMs(this.migrationConfig.checkInterval!));
        };
        await tick();
    }
};


export default MigratorOrchestrator;