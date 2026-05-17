import { execSync } from "node:child_process";
import KubernetesClient from "@lib/KubernetesClient";
import type { ProviderConfig } from "@lib/KubernetesClient";
import type { NodeScore, ExpandedNodeScore, CanmManagedNode } from "@/types";
import { logger, generateHash, ANNOTATION } from "@/utils";

const COMPONENT = "GKE Node Migrator";
const CANM_NODE_PREFIX = "gke-canm";
const GKE_NODEPOOL_LABEL = "cloud.google.com/gke-nodepool";

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

  drain(nodeName: string, gracefulPeriod?: number, force?: boolean): boolean {
    logger(COMPONENT, `Draning ${nodeName}...`);
    const drainSucced =  this.k8sClient.drain(nodeName, gracefulPeriod, force);
    if(!drainSucced) throw new Error(`Error on draining node ${nodeName}`);
    return drainSucced;
  }

  uncordon(nodeName: string): boolean {
    logger(COMPONENT, `Uncordoning ${nodeName}...`);
    const uncordonSucced = this.k8sClient.uncordon(nodeName);
    if(!uncordonSucced) throw new Error(`Error on uncordoning node ${nodeName}`);
    return uncordonSucced;
  }

  addNodeHighNodePool(): string {
    logger(COMPONENT, `Adding node on high demand node pool: ${this.hNodePool}`);
    const nodeName = this.addMigInstance(this.hNodePool);
    if(nodeName === null) throw new Error(`Error while trying to add node in highNodePool`);
    return nodeName;
  }

  addNodeLowNodePool(): string | null {
    logger(COMPONENT, `Adding node on low demand node pool: ${this.lNodePool}`);
    const nodeName = this.addMigInstance(this.lNodePool);
    if(nodeName === null) throw new Error(`Error while trying to add node in lowNodePool`);
    return nodeName;
  }

  removeNodeHighNodePool(nodeName: string): boolean {
    logger(COMPONENT, `Removing node on high demand node pool: ${this.hNodePool}`);
    const removeSucced = this.removeNode(nodeName, this.hNodePool);
    if(!removeSucced) throw new Error(`Error while removing node ${nodeName} on high node pool`);
    return removeSucced;
  }

  removeNodeLowNodePool(nodeName: string): boolean {
    logger(COMPONENT, `Removing node on low demand node pool: ${this.lNodePool}`);
    const removeSucced =  this.removeNode(nodeName, this.lNodePool);
    if(!removeSucced) throw new Error(`Error while removing node ${nodeName} on low node pool`);
    return removeSucced;
  }
  getClusterNodeInfo(): Array<any> {
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
        { encoding: "utf-8" }
      );
      const responseFormated = JSON.parse(response);
      return responseFormated;
    } catch (error) {
      logger(COMPONENT, `Error while accessing node pools informations: ${error}`, 'error');
      return [];
    }
  }

  private removeNode(nodeName: string, nodePool: string): boolean {
    const instances = this.getNodesFromPool(nodePool);
    const electedInstance: GkeInstance | undefined = instances.find(
      (i) => i?.name == nodeName
    );

    if (!electedInstance) {
      logger(COMPONENT, `No instance found with the name ${nodeName} on ${nodePool} node pool.`, 'info');
      return false;
    }
    const instanceZone = electedInstance.instance
      .split("/zones/")[1]
      .split("/")[0];
    const removeSucced =  this.removeMigInstance(
      nodeName,
      this.getInstanceGroup(nodePool)[0],
      instanceZone
    );

    return removeSucced;
  }
  private removeMigInstance(
    nodeName: string,
    instanceGroup: string,
    zone: string
  ): boolean {
    try {
      execSync(`
                gcloud compute instance-groups managed delete-instances \
                ${instanceGroup} \
                --zone=${zone} \
                --project=${this.k8sClient.getProject()} \
                --instances=${nodeName};
                `);
      logger(COMPONENT, 'Wating for instace group to stable...')
      execSync(`
          gcloud compute instance-groups managed wait-until --stable \
          ${instanceGroup} \
          --zone=${zone} \
          --project=${this.k8sClient.getProject()}
          `)
    } catch (error) {
      logger(COMPONENT, `Error while trying to remove ${nodeName} node on ${instanceGroup} instance group: ${error}`, 'info');
      return false;
    }
    logger(COMPONENT, `Node ${nodeName} removed from MIG ${instanceGroup} successfully`);
    return true;
  }

  private addMigInstance(nodePool: string): string | null {
    const project = this.k8sClient.getProject();
    const zone = this.k8sClient.getRegion();
    const instanceGroup = this.getInstanceGroup(nodePool)[0];
    const instanceName = this.generateInstanceName(nodePool);
    try {
      logger(COMPONENT, `Adding instance on MIG: ${instanceGroup}`);
      execSync(
        `gcloud compute instance-groups managed create-instance ${instanceGroup} \
          --instance=${instanceName} \
          --zone=${this.k8sClient.getRegion()} \
          --project=${this.k8sClient.getProject()}`
      )
      logger(COMPONENT, `Wating for instace group ${instanceGroup} to stable...`)
      execSync(`
          gcloud compute instance-groups managed wait-until --stable \
          ${instanceGroup} \
          --zone=${zone} \
          --project=${project}
      `)
      logger(COMPONENT, `Waiting for node ${instanceName} to become Ready...`);
      if (!this.k8sClient.waitUntilNodeReady(instanceName)) {
        logger(COMPONENT, `Node ${instanceName} not Ready in time; rolling back MIG instance`, 'error');
        const cleanedUp = this.removeMigInstance(instanceName, instanceGroup, zone);
        if (!cleanedUp) {
          logger(COMPONENT, `CRITICAL: failed to clean up orphan MIG instance ${instanceName}. Manual intervention required.`, 'error');
        }
        return null;
      }
      logger(COMPONENT, `Node is ready and already recognize by Kubernetes Cluster`);
      return instanceName;
    } catch (error) {
      logger(COMPONENT, `Error trying to add instance on MIG: ${error}`, 'error');
      return null;
    }
  }

  private generateInstanceName(nodePool: string): string{
    const MAX_INSTANCE_NAME_LENGTH = 63;
    const hashes = [generateHash(8), generateHash(4)]
    const clusterName = this.k8sClient.getClusterName();
    const options = [
        `${CANM_NODE_PREFIX}-${clusterName}-${nodePool}-${hashes[0]}-${hashes[1]}`,
        `${CANM_NODE_PREFIX}-${clusterName}-${nodePool}-${hashes[0]}`,
        `${CANM_NODE_PREFIX}-${nodePool}-${hashes[0]}`,
        `${CANM_NODE_PREFIX}-${hashes[0]}-${hashes[1]}`
      ]
    return options.find(name => name.length <= MAX_INSTANCE_NAME_LENGTH)!;
  }

  async getCanmManagedNodes(): Promise<CanmManagedNode[]> {
    const allNodes = await this.k8sClient.listNodes();
    return allNodes
      .filter((n) => n.name.startsWith(CANM_NODE_PREFIX))
      .flatMap((n) => {
        const nodePool = n.labels[GKE_NODEPOOL_LABEL];
        if (!nodePool) {
          logger(COMPONENT, `CANM-prefixed node ${n.name} has no ${GKE_NODEPOOL_LABEL} label; skipping`, 'error');
          return [];
        }
        return [{
          name: n.name,
          creationTimestamp: n.creationTimestamp,
          annotations: n.annotations,
          nodePool,
        }];
      });
  }

  private getInstanceGroup(nodePool: string) {
    const nodePools = this.getClusterNodeInfo();
    // Always returns an array with 1 elemente since de node name in GKE is a unique identifier.
    const np = nodePools.filter((n) => n.name === nodePool);
    const instanceGroupUrl = np[0].instanceGroupUrls;
    return instanceGroupUrl;
  }

  private getNodesFromPool(nodePool: string): Array<any> {
    const instanceGroupUrl = this.getInstanceGroup(nodePool);
    let instancesResponse: Array<any> = [];
    if (instanceGroupUrl && instanceGroupUrl.length > 0) {
      const instanceGroup = instanceGroupUrl[0];
      try {
        const instances = execSync(
          `
                        gcloud compute instance-groups managed list-instances \
                        ${instanceGroup} \
                        --region=${this.k8sClient.getRegion()} \
                        --project=${this.k8sClient.getProject()} \
                        --format=json
                    `,
          { encoding: "utf-8", stdio: "pipe" }
        );
        const instancesFormatted: Array<any> = JSON.parse(instances);
        instancesResponse = instancesFormatted;
      } catch (error) {
        logger(COMPONENT, `Error while trying do get instance group information: ${error}`, 'error');
      }
    }
    return instancesResponse;
  }

  private getInstancesCreationDates(instanceNames: string[]): Record<string, string | null> {
    const result: Record<string, string | null> = Object.fromEntries(instanceNames.map((n) => [n, null]));
    if (instanceNames.length === 0) return result;

    const filter = `name=(${instanceNames.join(" ")})`;
    try {
      const response = execSync(
        `gcloud compute instances list \
        --filter="${filter}" \
        --project=${this.k8sClient.getProject()} \
        --format=json`,
        { encoding: "utf-8", stdio: "pipe" }
      );
      const instances: Array<{ name: string; creationTimestamp: string }> = JSON.parse(response);
      instances.forEach((i) => {
        result[i.name] = i.creationTimestamp ?? null;
      });
    } catch (error) {
      logger(COMPONENT, `Error while getting creation dates for instances: ${error}`, 'error');
    }
    return result;
  }

  expandNodesInfo(nodes: NodeScore[]): ExpandedNodeScore[]{
    const nodesHNodePool = this.getNodesFromPool(this.hNodePool).map((hnp) => hnp.name);
    const nodesLNodePool = this.getNodesFromPool(this.lNodePool).map((lnp) => lnp.name);

    const getNodePoolFromNode = (nodeName: string) => {
      if (nodesHNodePool.includes(nodeName)) return this.hNodePool;
      return nodesLNodePool.includes(nodeName) ? this.lNodePool : null;
    }

    const creationDates = this.getInstancesCreationDates(nodes.map((n) => n.node));

    return nodes.flatMap((n) => {
      const nodePool = getNodePoolFromNode(n.node);
      const creationTimestamp = creationDates[n.node];
      if (!nodePool || !creationTimestamp) return [];
      return [{ node: n.node, score: n.score, nodePool, creationTimestamp }];
    });
  }

  annotateNode(nodeName: string, key: keyof typeof ANNOTATION, value: string){
    this.k8sClient.annotateNode(nodeName, key, value);
  }
}

export default GkeNodeMigrator;
