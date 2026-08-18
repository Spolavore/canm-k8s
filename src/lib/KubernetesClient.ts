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

    deleteNode(nodeName: string): boolean {
        try {
            execSync(`kubectl delete node ${nodeName}`, { encoding: 'utf-8' });
            return true;
        } catch (error) {
            logger(COMPONENT, `Error while trying to delete node ${nodeName}: ${error}`, 'error');
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

    cordon(nodeName: string): boolean {
        try {
            execSync(`kubectl cordon ${nodeName}`, { encoding: 'utf-8' });
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

    /**
     * Retorna os pods DESPEJÁVEIS de um nó (exclui DaemonSet e mirror/static pods,
     * que o drain ignora). Usado pelo drain pausado para evacuar em lotes.
     */
    async getPodsOnNode(nodeName: string): Promise<Array<{ namespace: string; name: string }>> {
        try {
            const api = this.getCoreV1Api();
            const podList = await api.listPodForAllNamespaces({ fieldSelector: `spec.nodeName=${nodeName}` });
            return podList.items
                .filter((pod: k8s.V1Pod) => {
                    // mirror/static pods não são despejáveis
                    if (pod.metadata?.annotations?.['kubernetes.io/config.mirror'] != null) return false;
                    // pods de DaemonSet não são despejáveis
                    if (pod.metadata?.ownerReferences?.some((o) => o.kind === 'DaemonSet')) return false;
                    return true;
                })
                .map((pod: k8s.V1Pod) => ({
                    namespace: pod.metadata?.namespace ?? '',
                    name: pod.metadata?.name ?? '',
                }))
                .filter((p) => p.namespace && p.name);
        } catch (error) {
            logger(COMPONENT, `Error while listing pods on node ${nodeName}: ${error}`, 'error');
            return [];
        }
    }

    async evictPod(namespace: string, name: string, gracePeriodSeconds?: number): Promise<boolean> {
        const api = this.getCoreV1Api();
        const body: k8s.V1Eviction = {
            apiVersion: 'policy/v1',
            kind: 'Eviction',
            metadata: { name, namespace },
            ...(gracePeriodSeconds != null && { deleteOptions: { gracePeriodSeconds } }),
        };
        try {
            await api.createNamespacedPodEviction({ name, namespace, body });
            return true;
        } catch (error: any) {
            const code = error?.statusCode ?? error?.code ?? error?.response?.statusCode;
            // 429: o PDB impediria a remoção agora — backpressure, não é erro fatal.
            if (code === 429) {
                logger(COMPONENT, `Eviction of ${namespace}/${name} blocked by PDB (429); will retry later`, 'info');
                return false;
            }
            // 404: pod já não existe — considerar despejado.
            if (code === 404) {
                logger(COMPONENT, `Pod ${namespace}/${name} already gone (404); treating as evicted`, 'info');
                return true;
            }
            logger(COMPONENT, `Error while evicting pod ${namespace}/${name}: ${error}`, 'error');
            throw error;
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
