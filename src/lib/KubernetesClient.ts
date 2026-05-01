import * as k8s from '@kubernetes/client-node';
import * as gkeCredentialsGenerator from '@config/gkeCredentialsGenerator';

const externalProvider = process.env.EXTERNAL_PROVIDER;

switch (externalProvider) {
  case 'gke':
    gkeCredentialsGenerator.setCredentials();
    break;
  default:
    console.log('[KubernetesClient] No external provider detected, will try using local kube config file');
}

class KubernetesClient {
  private kc: k8s.KubeConfig;

  constructor() {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
  }

  getCoreV1Api(): k8s.CoreV1Api {
    return this.kc.makeApiClient(k8s.CoreV1Api);
  }

  getAppsV1Api(): k8s.AppsV1Api {
    return this.kc.makeApiClient(k8s.AppsV1Api);
  }
}

export default KubernetesClient;
