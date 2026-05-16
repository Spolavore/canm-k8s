import { execSync } from "node:child_process";
import KubernetesClient from "@lib/KubernetesClient";
import type { ProviderConfig } from "@lib/KubernetesClient";
import type { NodeScore, ExpandedNodeScore } from "@/types";
import { logger, generateHash } from "@/utils";

const COMPONENT = "GKE Node Migrator";

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
    return this.k8sClient.drain(nodeName, gracefulPeriod, force);
  }
  addNodeHighNodePool(): string | null {
    logger(COMPONENT, `Adding node on high demand node pool: ${this.hNodePool}`);
    return this.addMigInstance(this.hNodePool);
  }

  addNodeLowNodePool(): string | null {
    logger(COMPONENT, `Adding node on low demand node pool: ${this.lNodePool}`);
    return this.addMigInstance(this.lNodePool);
  }

  removeNodeHighNodePool(nodeName: string): boolean {
    logger(COMPONENT, `Removing node on high demand node pool: ${this.hNodePool}`);
    return this.removeNode(nodeName, this.hNodePool);
  }

  removeNodeLowNodePool(nodeName: string): boolean {
    logger(COMPONENT, `Removing node on low demand node pool: ${this.lNodePool}`);
    return this.removeNode(nodeName, this.lNodePool);
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
    return this.removeMigInstance(
      nodeName,
      this.getInstanceGroup(nodePool)[0],
      instanceZone
    );
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
    return true;
  }

  private addMigInstance(nodePool: string): string | null{
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
        return null;
      }
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
        `gke-${clusterName}-${nodePool}-${hashes[0]}-${hashes[1]}`,
        `gke-${clusterName}-${nodePool}-${hashes[0]}`,
        `gke-${nodePool}-${hashes[0]}`,
        `gke-canm-node-${hashes[0]}-${hashes[1]}`
      ]
    return options.find(name => name.length <= MAX_INSTANCE_NAME_LENGTH)!;
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
}

export default GkeNodeMigrator;
