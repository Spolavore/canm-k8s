const k8s = require('@kubernetes/client-node');
const externalProvider = process.env.EXTERNAL_PROVIDER;
const gkeCredentialsGenerator = require('../config/gkeCredentialsGenerator');

switch(externalProvider){
    case 'gke':
        gkeCredentialsGenerator.setCredentials();
        break;
    default:
        console.log('[KubernetesClient] No external provider detected, will try using local kube config file');
}

class KubernetesClient {
  constructor() {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
  }

  getCoreV1Api() {
    return this.kc.makeApiClient(k8s.CoreV1Api);
  }

  getAppsV1Api() {
    return this.kc.makeApiClient(k8s.AppsV1Api);
  }
}

module.exports = KubernetesClient;