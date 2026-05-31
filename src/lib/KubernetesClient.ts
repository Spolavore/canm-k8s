import * as k8s from '@kubernetes/client-node';
import * as gkeCredentialsGenerator from '@config/gkeCredentialsGenerator';
import { execSync } from 'node:child_process';
import { AvailableProviders } from '@/types';
import { logger, ANNOTATION } from '@/utils';
import type { KubernetesNodes } from '@/types';

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
            execSync(`kubectl drain ${nodeName} ${gracefulPeriodCmd} ${forceCmd} --timeout=600s`, {
                encoding: 'utf-8',
            });
            return true;
        } catch (error) {
            logger(COMPONENT, `Error while trying to drain ${nodeName}: ${error}`, 'error');
            return false;
        }
    }

    uncordon(nodeName: string): boolean {
        try {
            execSync(`kubectl uncordon ${nodeName}`, { encoding: 'utf-8' });
            return true;
        } catch (error) {
            logger(COMPONENT, `Error while trying to uncordon ${nodeName}: ${error}`, 'error');
            return false;
        }
    }

    isNodeCordoned(nodeName: string): boolean {
        try {
            const out = execSync(`kubectl get node ${nodeName} -o jsonpath='{.spec.unschedulable}'`, {
                encoding: 'utf-8',
            });
            return out.trim() === 'true';
        } catch (error) {
            logger(COMPONENT, `Error while checking cordoned status of ${nodeName}: ${error}`, 'error');
            return false;
        }
    }

    waitUntilNodeReady(nodeName: string, readyTimeoutSeconds = 300, registrationTimeoutSeconds = 120): boolean {
        try {
            execSync(`kubectl wait --for=create node/${nodeName} --timeout=${registrationTimeoutSeconds}s`, {
                encoding: 'utf-8',
            });
        } catch (error) {
            logger(
                COMPONENT,
                `Node ${nodeName} was not registered in ${registrationTimeoutSeconds}s: ${error}`,
                'error',
            );
            return false;
        }
        try {
            execSync(`kubectl wait --for=condition=Ready node/${nodeName} --timeout=${readyTimeoutSeconds}s`, {
                encoding: 'utf-8',
            });
            return true;
        } catch (error) {
            logger(COMPONENT, `Node ${nodeName} did not become Ready in ${readyTimeoutSeconds}s: ${error}`, 'error');
            return false;
        }
    }

    annotateNode(nodeName: string, key: keyof typeof ANNOTATION, value: string): boolean {
        try {
            const fullDomainKey = ANNOTATION[key];
            const formattedValue = value.replace(/'/g, "'\\''");
            execSync(`kubectl annotate nodes ${nodeName} --overwrite ${fullDomainKey}=${formattedValue}`);
            logger(
                COMPONENT,
                `Node ${nodeName} annotated with ${fullDomainKey}=${formattedValue}`,
                'info',
                process.env.SHOW_DECISIONS_LOGS === 'TRUE',
            );
            return true;
        } catch (error) {
            logger(COMPONENT, `Error trying to annotate node ${nodeName}: ${error}`);
            return false;
        }
    }

    removeNodeAnnotation(nodeName: string, key: keyof typeof ANNOTATION): boolean {
        try {
            const fullDomainKey = ANNOTATION[key];
            execSync(`kubectl annotate nodes ${nodeName} ${fullDomainKey}-`);
            logger(
                COMPONENT,
                `Removed annotation ${fullDomainKey} from node ${nodeName}`,
                'info',
                process.env.SHOW_DECISIONS_LOGS === 'TRUE',
            );
            return true;
        } catch (error) {
            logger(COMPONENT, `Error trying to remove annotation from node ${nodeName}: ${error}`);
            return true;
        }
    }

    static async getNodeNames(): Promise<string[]> {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const api = kc.makeApiClient(k8s.CoreV1Api);
        const nodeList = await api.listNode();
        return nodeList.items.map((node: k8s.V1Node) => node.metadata?.name ?? '').filter(Boolean);
    }

    async getNodeByName(nodeName: string): Promise<KubernetesNodes | null> {
        try {
            const api = this.getCoreV1Api();
            const node = await api.readNode({ name: nodeName });
            return {
                name: node.metadata?.name ?? '',
                creationTimestamp: node.metadata?.creationTimestamp
                    ? new Date(node.metadata.creationTimestamp).toISOString()
                    : null,
                annotations: node.metadata?.annotations ?? {},
                labels: node.metadata?.labels ?? {},
            };
        } catch (error: any) {
            const code = error?.statusCode ?? error?.code ?? error?.response?.statusCode;
            if (code === 404) return null;
            logger(COMPONENT, `Error fetching node ${nodeName}: ${error}`, 'error');
            return null;
        }
    }

    async listNodes(): Promise<KubernetesNodes[]> {
        try {
            const api = this.getCoreV1Api();
            const nodeList = await api.listNode();
            return nodeList.items
                .map((node: k8s.V1Node) => ({
                    name: node.metadata?.name ?? '',
                    creationTimestamp: node.metadata?.creationTimestamp
                        ? new Date(node.metadata.creationTimestamp).toISOString()
                        : null,
                    annotations: node.metadata?.annotations ?? {},
                    labels: node.metadata?.labels ?? {},
                }))
                .filter((n) => n.name);
        } catch (error) {
            logger(COMPONENT, `Error while listing nodes: ${error}`, 'error');
            return [];
        }
    }

    getCoreV1Api(): k8s.CoreV1Api {
        return this.kc.makeApiClient(k8s.CoreV1Api);
    }

    getAppsV1Api(): k8s.AppsV1Api {
        return this.kc.makeApiClient(k8s.AppsV1Api);
    }
}

export default KubernetesClient;
