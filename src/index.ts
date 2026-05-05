import 'dotenv/config';
import { loadProviderConfig } from '@lib/KubernetesClient';
import MetricsAdapter from '@components/MetricsAdapter';
import GkeNodeMigrator from '@components/GkeNodeMigrator';
import MigratorOrchestrator from '@components/MigratorOrchestrator';

const parseWeight = (value: string | undefined, fallback: number): number => {
  const parsed = parseFloat(value ?? '');
  return isNaN(parsed) ? fallback : parsed;
};

const hNodePool = process.env.HIGH_NODE_POOL as string;
const lNodePool = process.env.LOW_NODE_POOL as string;

const cpu_weight = parseWeight(process.env.CPU_WEIGHT, 0.65);
const memory_weight = parseWeight(process.env.MEMORY_WEIGHT, 0.25);
const network_weight = parseWeight(process.env.NETWORK_WEIGHT, 0.1);


const providerConfig = loadProviderConfig();
const metricsAdapter = new MetricsAdapter({cpu: cpu_weight, memory: memory_weight, network: network_weight});
const nodeMigrator = new GkeNodeMigrator(providerConfig, process.env.HIGH_NODE_POOL as string, process.env.LOW_NODE_POOL as string);
const migrator = new MigratorOrchestrator(hNodePool, lNodePool, {cpu: process.env.CPU_WEIGHT, memory: process.env.MEMORY_WEIGHT, network: process.env.NETWORK_WEIGHT}, 'gke', providerConfig)
async function main(): Promise<void> {
  // const cpuUsage = await metricsAdapter.getNodesCpuUsage('1h') as any;
  // const networkThroughput = await metricsAdapter.getNodesNetworkReceivedBytes('1h', undefined, 'mb') as any;
  // const memoryUsage = await metricsAdapter.getNodesMemoryUsage();
  // const nodesScore = await metricsAdapter.getNodesScore();
  await migrator.startLoop();
}

main();
