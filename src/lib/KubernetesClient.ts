import * as k8s from '@kubernetes/client-node';
import * as gkeCredentialsGenerator from '@config/gkeCredentialsGenerator';
import { execSync } from 'node:child_process';
import { AvailableProviders } from '@/types';
import { logger } from '@/utils';

const COMPONENT = 'KubernetesClient';

export type ProviderConfig = {
  clusterName: string;
  region: string;
  project: string;
};

export function loadProviderConfig(): ProviderConfig {
  const provider = (process.env.EXTERNAL_PROVIDER ?? null) as AvailableProviders;
  switch (provider) {
    case 'gke':
      gkeCredentialsGenerator.setCredentials();
      return {
        clusterName: process.env.GKE_CLUSTER_NAME ?? '',
        region: process.env.GKE_REGION ?? '',
        project: process.env.GKE_PROJECT ?? '',
      };
    default:
      logger(COMPONENT, 'No external provider detected, will try using local kube config file');
      return { clusterName: '', region: '', project: '' };
  }
}

class KubernetesClient {
  private kc: k8s.KubeConfig;
  private clusterName: string;
  private region: string;
  private project: string;

  constructor(config: ProviderConfig) {
    this.clusterName = config.clusterName;
    this.region = config.region;
    this.project = config.project;

    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
  }

  getClusterName(): string {
    return this.clusterName;
  }

  getRegion(): string {
    return this.region;
  }

  getProject(): string {
    return this.project;
  }

  drain(nodeName: string, gracefulPeriod?: number, force?: boolean): boolean {
    const gracefulPeriodCmd = gracefulPeriod ? `--grace-period=${gracefulPeriod}` : '';
    const forceCmd = force ? '--force --ignore-daemonsets --delete-emptydir-data' : '';
    try {
      execSync(`kubectl drain ${nodeName} ${gracefulPeriodCmd} ${forceCmd}`, { encoding: 'utf-8' });
      return true;
    } catch (error) {
      logger(COMPONENT, `Error while trying to drain ${nodeName}: ${error}`, 'error');
      return false;
    }
  }

  waitUntilNodeReady(nodeName: string, readyTimeoutSeconds = 300, registrationTimeoutSeconds = 120): boolean {
    try {
      execSync(
        `kubectl wait --for=create node/${nodeName} --timeout=${registrationTimeoutSeconds}s`,
        { encoding: 'utf-8' }
      );
    } catch (error) {
      logger(COMPONENT, `Node ${nodeName} was not registered in ${registrationTimeoutSeconds}s: ${error}`, 'error');
      return false;
    }
    try {
      execSync(
        `kubectl wait --for=condition=Ready node/${nodeName} --timeout=${readyTimeoutSeconds}s`,
        { encoding: 'utf-8' }
      );
      return true;
    } catch (error) {
      logger(COMPONENT, `Node ${nodeName} did not become Ready in ${readyTimeoutSeconds}s: ${error}`, 'error');
      return false;
    }
  }

  static async getNodeNames(): Promise<string[]> {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const api = kc.makeApiClient(k8s.CoreV1Api);
    const nodeList = await api.listNode();
    return nodeList.items.map((node: k8s.V1Node) => node.metadata?.name ?? '').filter(Boolean);
  }

  getCoreV1Api(): k8s.CoreV1Api {
    return this.kc.makeApiClient(k8s.CoreV1Api);
  }

  getAppsV1Api(): k8s.AppsV1Api {
    return this.kc.makeApiClient(k8s.AppsV1Api);
  }
}

export default KubernetesClient;
