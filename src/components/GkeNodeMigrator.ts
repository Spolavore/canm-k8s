import { execSync } from "node:child_process";
import KubernetesClient from '@lib/KubernetesClient';
import type { ProviderConfig } from '@lib/KubernetesClient';

type GkeInstance = {
    id: string;
    instance: string;
    instanceStatus: string;
    name: string;
    currentAction?: string;
    version?: {
        instanceTemplate?: string;
    };
};

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
            console.log(`[GKE Node Migrator] Error while accessing node pools informations: ${error}`);
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
            console.log(`[GKE Node Migrator] Node pool ${nodePool} resized to ${numNodes} node(s) in ${elapsed}s`);
            return true;
        } catch (error) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.error(`[GKE Node Migrator] Failed to resize node pool ${nodePool} to ${numNodes} after ${elapsed}s: ${error}`);
            return false;
        }
    }
    
    addNodeHighNodePool(): boolean {
        console.log(`[GKE Node Migrator] Resizing high demand node pool: ${this.hNodePool}`);
        return this.resizeNodePool(this.hNodePool, 1);
    }

    addNodeLowNodePool(numNodes: number): boolean {
        console.log(`[GKE Node Migrator] Resizing low demand node pool: ${this.lNodePool}`);
        return this.resizeNodePool(this.lNodePool, numNodes);
    }

    removeNodeHighNodePool(nodeName: string): boolean  {
        const instances = this.getNodesFromPool(this.hNodePool);
        const electedInstance: GkeInstance | undefined = instances.find(i => i?.name == nodeName);

        if(!electedInstance){
            console.info(`[GKE Node Migrator] No instance found with the name ${nodeName} on ${this.hNodePool} node pool.`);
            return false;
        }

        const instanceZone = electedInstance.instance.split('/zones/')[1].split('/')[0];

        console.log(electedInstance)
        return this.removeNode(nodeName, this.getInstanceGroup(this.hNodePool), instanceZone);
    }

    removeNodeLowNodePool(nodeName: string): boolean  {
        const instances = this.getNodesFromPool(this.lNodePool);
        return false
    }

    private removeNode(nodeName: string, instanceGroup: string, zone: string): boolean{
        try {
            execSync(`
                gcloud compute instance-groups managed delete-instances \
                ${instanceGroup} \
                --zone=${zone} \
                --project=${this.k8sClient.getProject()} \
                --instances=${nodeName};
                `)
        } catch (error) {
            console.info(`[GKE Node Migrator] Error while trying to remove ${nodeName} node on ${instanceGroup} instance group: ${error}`);
            return false;
        }
        return true;
    }

    private getInstanceGroup(nodePool: string) {
        const nodePools = this.getClusterNodeInfo();
        // Always returns an array with 1 elemente since de node name in GKE is a unique identifier.
        const highNodePool = nodePools.filter(n => n.name === this.hNodePool);
        const instanceGroupUrl = highNodePool[0].instanceGroupUrls;
        return instanceGroupUrl;
    }
    private getNodesFromPool(nodePool:  string): Array<any> {
        const instanceGroupUrl = this.getInstanceGroup(nodePool);
        let instancesResponse: Array<any> = [];
        if(instanceGroupUrl && instanceGroupUrl.length > 0) {
            const instanceGroup = instanceGroupUrl[0];      
            try {
                 const instances = execSync(`
                        gcloud compute instance-groups managed list-instances \
                        ${instanceGroup} \
                        --region=${this.k8sClient.getRegion()} \
                        --project=${this.k8sClient.getProject()} \
                        --format=json
                    `,
                    {encoding: 'utf-8', stdio: 'pipe'},
                    
                )    
                const instancesFormatted: Array<any> = JSON.parse(instances);
                instancesResponse = instancesFormatted;             
            } catch (error) {
                console.error(`[GKE Node Migrator] Error while trying do get instance group information: ${error}`)
            }      
        }
        return instancesResponse;
    }
}

export default GkeNodeMigrator;
