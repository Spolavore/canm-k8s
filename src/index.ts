import 'dotenv/config';
import KubernetesClient from '@lib/KubernetesClient';
import MetricsAdapter from '@components/MetricsAdapter';

const client = new KubernetesClient();
const metricsAdapter = new MetricsAdapter();
async function main(): Promise<void> {
  const cpuUsage = await metricsAdapter.getNodesCpuUsage('1h') as any;
  const networkThroughput = await metricsAdapter.getNodesNetworkReceivedBytes('1h', undefined, 'mb') as any;
  const memoryUsage = await metricsAdapter.getNodesMemoryUsage();
  console.log(memoryUsage);
}

main();
