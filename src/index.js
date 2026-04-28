require('dotenv').config();
const KubernetesClient = require('./lib/KubernetesClient');

const client = new KubernetesClient();
const k8sApi = client.getCoreV1Api();

