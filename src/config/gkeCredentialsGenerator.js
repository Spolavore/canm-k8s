const { execSync } = require('child_process');
const REQUIRED_ENV_VARS = ['GKE_CLUSTER_NAME', 'GKE_REGION', 'GKE_PROJECT'];

/**
 * Command to configure GKE cluster config in your local machine
 * File populated: ~/.kube/config
 * @returns void
 */
function setCredentials() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`[gkeCredentialsGenerator] Missing required env vars: ${missing.join(', ')}`);
    return;
  }

  const internalIpFlag = process.env.GKE_INTERNAL_IP === 'true' ? '--internal-ip' : '';

  const k8sCredentialsCommand = [
    'gcloud container clusters get-credentials',
    process.env.GKE_CLUSTER_NAME,
    '--region', process.env.GKE_REGION,
    '--project', process.env.GKE_PROJECT,
    internalIpFlag,
  ].join(' ');

  execSync(k8sCredentialsCommand);
}

module.exports = { setCredentials };