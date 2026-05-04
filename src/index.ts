import 'dotenv/config';
import { loadProviderConfig } from '@lib/KubernetesClient';
import MetricsAdapter from '@components/MetricsAdapter';
import GkeNodeMigrator from '@components/GkeNodeMigrator';

const parseWeight = (value: string | undefined, fallback: number): number => {
  const parsed = parseFloat(value ?? '');
  return isNaN(parsed) ? fallback : parsed;
};

const cpu_weight = parseWeight(process.env.CPU_WEIGHT, 0.65);
const memory_weight = parseWeight(process.env.MEMORY_WEIGHT, 0.25);
const network_weight = parseWeight(process.env.NETWORK_WEIGHT, 0.1);


const providerConfig = loadProviderConfig();
const metricsAdapter = new MetricsAdapter(cpu_weight, memory_weight, network_weight);
const nodeMigrator = new GkeNodeMigrator(providerConfig, process.env.HIGH_NODE_POOL as string, process.env.LOW_NODE_POOL as string);

async function main(): Promise<void> {
  const cpuUsage = await metricsAdapter.getNodesCpuUsage('1h') as any;
  const networkThroughput = await metricsAdapter.getNodesNetworkReceivedBytes('1h', undefined, 'mb') as any;
  const memoryUsage = await metricsAdapter.getNodesMemoryUsage();
  const m = await metricsAdapter.getNodesScore();
  console.log(m);
}

main();
