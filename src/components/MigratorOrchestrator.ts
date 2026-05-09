import MetricsAdapter from "@components/MetricsAdapter";
import GkeNodeMigrator from "@components/GkeNodeMigrator";
import { AvailableProviders, ComparisonOperator, MigrationConfig, RawWeightsConfig, WeightsConfig } from "@/types";
import { comp } from "@/utils/math";
import { ProviderConfig } from "@/lib/KubernetesClient";
import { exit } from "process";
import type { ExpandedNodeScore } from "@/types";
import { logger } from "@/utils";

const COMPONENT = "Migrator Orchestrator";

class MigratorOrchestrator {

    private DEFAULT_CPU_WEIGHT = 0.60;
    private DEFAULT_MEMORY_WEIGHT = 0.3;
    private DEFAULT_NETWORK_WEIGHT = 0.1;

    private metrics: MetricsAdapter;
    private nodeMigrator!: GkeNodeMigrator;

    private migrationConfig: MigrationConfig;
    private provider: AvailableProviders;
    private weights: WeightsConfig;


    constructor(migrationConfig: MigrationConfig, rawWeights: RawWeightsConfig, provider: AvailableProviders, providerConf: ProviderConfig){
        this.migrationConfig = {
            policy: 'prioritizeCost',
            checkInterval: 60,
            ...migrationConfig,
        };
        this.provider = provider;
        this.weights = {
            cpu: this.parseWeight(rawWeights.cpu, this.DEFAULT_CPU_WEIGHT),
            memory: this.parseWeight(rawWeights.memory, this.DEFAULT_MEMORY_WEIGHT),
            network: this.parseWeight(rawWeights.network, this.DEFAULT_NETWORK_WEIGHT),
        };
        this.metrics = new MetricsAdapter(this.weights);
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

    private evaluateNodePool(nodesScore: ExpandedNodeScore[], threshold: number, cmp: ComparisonOperator){
        let actionEffectuated = false;
        for(const node of nodesScore){
            if(comp(node.score, threshold, cmp)){
                this.migrateNode(node);
                actionEffectuated = true;
                break;
            };
        }

        return actionEffectuated;
    }
    private migrateNode(node: ExpandedNodeScore){
        const ageInHours = this.getNodeAgeInHours(node.creationTimestamp);
        const nodePoolTo = node.nodePool === this.migrationConfig.lowNodePool ? this.migrationConfig.highNodePool : this.migrationConfig.lowNodePool;
        logger(COMPONENT, `Migrating ${node.node} with score ${node.score.toFixed(2)} to ${nodePoolTo}`);
        const start = Date.now();
        switch(nodePoolTo){
            case this.migrationConfig.lowNodePool: 
                this.nodeMigrator.addNodeLowNodePool();
                this.nodeMigrator.drain(node.node, 60, true);
                this.nodeMigrator.removeNodeHighNodePool(node.node);
                break

            case this.migrationConfig.highNodePool:
                this.nodeMigrator.addNodeHighNodePool();
                this.nodeMigrator.drain(node.node, 60, true);
                this.nodeMigrator.removeNodeLowNodePool(node.node);
                break
        }
        logger(COMPONENT, `Migration finished in ${(Date.now() - start) / 1000}s`);
    }
    private getNodeAgeInHours(creationTimestamp: string): number {
        return (Date.now() - new Date(creationTimestamp).getTime()) / (1000 * 60 * 60);
    }

    private sortByScore(nodes: ExpandedNodeScore[], order: 'asc' | 'desc'): ExpandedNodeScore[] {
        const direction = order === 'asc' ? 1 : -1;
        return [...nodes].sort((a, b) => direction * (a.score - b.score));
    }

    private async evaluateCluster(): Promise<any>{
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
            case 'prioritizeCost': {
                hasChanged = this.evaluateNodePool(nodesScoreLowNodePool, this.migrationConfig.lowScoreThreshold, 'lte');
                if(hasChanged) return;
                this.evaluateNodePool(nodesScoreHighNodePool, this.migrationConfig.highScoreThreshold, 'gte');
                return;
            }
                
            case 'prioritizePerfomance': {
                hasChanged = this.evaluateNodePool(nodesScoreHighNodePool, this.migrationConfig.highScoreThreshold, 'gte');
                if(hasChanged) return;
                this.evaluateNodePool(nodesScoreLowNodePool, this.migrationConfig.lowScoreThreshold, 'lte');
               return;                
            }
                
        }
    }

    async start() {
        const tick = async () => {  
            await this.evaluateCluster()            
            setTimeout(tick, this.migrationConfig.checkInterval! * 1000);
        };
        await tick();
    }
};


export default MigratorOrchestrator;