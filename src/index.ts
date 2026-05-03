import 'dotenv/config';
import { loadProviderConfig } from '@lib/KubernetesClient';
import MetricsAdapter from '@components/MetricsAdapter';
import GkeNodeMigrator from '@components/GkeNodeMigrator';

const providerConfig = loadProviderConfig();
const metricsAdapter = new MetricsAdapter();
const nodeMigrator = new GkeNodeMigrator(providerConfig, process.env.HIGH_NODE_POOL as string, process.env.LOW_NODE_POOL as string);

async function main(): Promise<void> {
  const cpuUsage = await metricsAdapter.getNodesCpuUsage('1h') as any;
  const networkThroughput = await metricsAdapter.getNodesNetworkReceivedBytes('1h', undefined, 'mb') as any;
  const memoryUsage = await metricsAdapter.getNodesMemoryUsage();
  // nodeMigrator.addNodeHighNodePool();
  console.log(nodeMigrator.removeNodeHighNodePool('gke-beta-pool-beta-high-0de43245-x5sj'))
}

main();
