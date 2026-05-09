import { execSync } from 'child_process';
import { logger } from '@/utils';

const COMPONENT = 'GKE Credentials Generator';
const REQUIRED_ENV_VARS = ['GKE_CLUSTER_NAME', 'GKE_REGION', 'GKE_PROJECT'] as const;

function setCredentials(): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    logger(COMPONENT, `Missing required env vars: ${missing.join(', ')}`, 'error');
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

export { setCredentials };
