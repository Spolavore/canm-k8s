import MetricsAdapter from "@components/MetricsAdapter";
import GkeNodeMigrator from "@components/GkeNodeMigrator";
import { AvailableProviders, MigrationConfig, RawWeightsConfig, WeightsConfig } from "@/types";
import { ProviderConfig } from "@/lib/KubernetesClient";
import { exit } from "process";
import type { ExpandedNodeScore } from "@/types";

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
            console.info("[Migrator Orchestrator] No provider was found, exiting...")
            exit(1)
        }
    }
    
    private selectNodeMigrator (config: ProviderConfig) {
        switch(this.provider){
            case 'gke':
                this.nodeMigrator = new GkeNodeMigrator(config, this.migrationConfig.lowNodePool, this.migrationConfig.highNodePool);
                break
        }
    }
    private parseWeight (value: string | undefined, fallback: number): number {
        const parsed = parseFloat(value ?? '');
        return isNaN(parsed) ? fallback : parsed;
    };
    private async getNodesScore(): Promise<ExpandedNodeScore[] | null> {
        const nodesScore = await this.metrics.getNodesScore('1h');
        if(nodesScore && nodesScore.length !== 0){
            return this.nodeMigrator.expandNodesInfo(nodesScore);
        };
        return null
    }
    async start() {
        const tick = async () => {
            const nodesScore = await this.getNodesScore();
            console.log(nodesScore);
            setTimeout(tick, this.migrationConfig.checkInterval! * 1000);
        };
        await tick();
    }
};


export default MigratorOrchestrator;