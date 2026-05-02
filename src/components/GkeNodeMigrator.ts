import { execSync } from "node:child_process";
import KubernetesClient from '@lib/KubernetesClient';
import type { ProviderConfig } from '@lib/KubernetesClient';

class GkeNodeMigrator {
    private k8sClient: KubernetesClient;
    private hNodePool: string;
    private lNodePool: string;

    constructor(config: ProviderConfig, hNodePool: string, lNodePool: string) {
        this.k8sClient = new KubernetesClient(config);
        this.hNodePool = hNodePool;
        this.lNodePool = lNodePool;
    }

    drain(nodePool: string, gracefulPeriod?: number, force?: boolean): boolean {
        return this.k8sClient.drain(nodePool, gracefulPeriod, force);
    }

    getClusterNodeInfo(): Array<any>{
        const clusterName = this.k8sClient.getClusterName();
        const region = this.k8sClient.getRegion();
        const project = this.k8sClient.getProject();
        try {
            const response = execSync(
                `gcloud container node-pools list \
                --cluster ${clusterName} \
                --region ${region} \
                --project ${project} \
                --format=json
    
            `,
            { encoding: 'utf-8'}
            )
            const responseFormated = JSON.parse(response);
            return responseFormated;
        } catch (error) {
            console.log(`[Node Migrator] Error while accessing node pools informations: ${error}`);
            return [];
        }
    }

    private resizeNodePool(nodePool: string, numNodes: number): boolean {
        const clusterName = this.k8sClient.getClusterName();
        const region = this.k8sClient.getRegion();
        const project = this.k8sClient.getProject();
        const start = Date.now();
        try {
            execSync(`
                gcloud container clusters resize ${clusterName} \
                --node-pool ${nodePool} \
                --num-nodes ${numNodes} \
                --zone ${region} \
                --project ${project} \
                --quiet
            `, { stdio: 'pipe' });
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.log(`[Node Migrator] Node pool ${nodePool} resized to ${numNodes} node(s) in ${elapsed}s`);
            return true;
        } catch (error) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.error(`[Node Migrator] Failed to resize node pool ${nodePool} to ${numNodes} after ${elapsed}s: ${error}`);
            return false;
        }
    }
    
    addNodeHighNodePool(): boolean {
        console.log(`[Node Migrator] Resizing high demand node pool: ${this.hNodePool}`);
        return this.resizeNodePool(this.hNodePool, 1);
    }

    addNodeLowNodePool(numNodes: number): boolean {
        console.log(`[Node Migrator] Resizing low demand node pool: ${this.lNodePool}`);
        return this.resizeNodePool(this.lNodePool, numNodes);
    }

    removeNodeHighNodePool(nodeName: string): boolean  {
        const nodePools = this.getClusterNodeInfo();
        // Always returns an array with 1 elemente since de node name in GKE is a unique identifier.
        const highNodePool = nodePools.filter(n => n.name === this.hNodePool);
        const instanceGroupUrl = highNodePool[0].instanceGroupUrls;
        console.log(instanceGroupUrl)
        if(instanceGroupUrl && instanceGroupUrl.length > 0) {
            const instanceGroupElectedNode =  instanceGroupUrl.find((ig: string) => ig.includes(nodeName));
            console.log(instanceGroupElectedNode)
        }

        return false
    }
}

export default GkeNodeMigrator;
