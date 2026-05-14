import { instantQuery, PrometheusResults } from '@/services/prometheus.service';
import { CPU_USAGE_QUERY, MEMORY_USAGE_QUERY } from '@/repositories/prometheus.queries';
import { normalize } from '@/utils';
import KubernetesClient from '@/lib/KubernetesClient';
import type { WeightsConfig } from '@/types';
import type { NodeScore } from '@/types';

type AvailableReductions = 'max' | 'min' | 'avg' | 'sum';

class MetricsAdapter {
  private cpuWeight: number
  private memoryWeight: number

  constructor(weights: WeightsConfig){
    const [cpu, memory] = normalize([weights.cpu, weights.memory]);
    this.cpuWeight = cpu;
    this.memoryWeight = memory;
  }

  async getNodesScore(timeWindow: string = '1h'): Promise<NodeScore[]>{
    const nodesScore: Record<string, number> = {};
    const nodes = await KubernetesClient.getNodeNames();
    nodes.forEach(n => {
      nodesScore[n] = -1
    })

    const [cpuMetrics, memoryMetrics] = await Promise.all([
      this.getNodesCpuUsage(timeWindow),
      this.getNodesMemoryUsage(),
    ]) as [PrometheusResults[], PrometheusResults[]]

    cpuMetrics.forEach(cm => {
      nodesScore[cm.metric.node] = Number(cm.value[1]) * this.cpuWeight;
    })

    memoryMetrics.forEach(mm => {
      nodesScore[mm.metric.node] += Number(mm.value[1]) * this.memoryWeight;
    })
    
    return Object.entries(nodesScore).map(([node, score]) => ({ node, score: Number((score / 100).toFixed(3)) }));
  }
  /*
  * Returns the CPU use of each node in the cluster in percentage
  */
  async getNodesCpuUsage(
    timeWindow: string,
    reduction?: AvailableReductions
  ): Promise<PrometheusResults[] | PrometheusResults> {
    const results = await instantQuery({ query: CPU_USAGE_QUERY, timeWindow });

    if (results && reduction) {
      return this.reduct(results, reduction);
    }

    return results;
  }
  /*
  * Returns the Memory use of each node in the cluster in percentage
  */
  async getNodesMemoryUsage(
    reduction?: AvailableReductions
  ): Promise<PrometheusResults[] | PrometheusResults> {
    const results = await instantQuery({ query: MEMORY_USAGE_QUERY });
    if (results && reduction) {
      return this.reduct(results, reduction);
    }

    return results;
  }

  private reduct(results: Array<PrometheusResults>, reduction: AvailableReductions): PrometheusResults {
    const sum = results.reduce((acc, curr) => acc + Number(curr.value[1]), 0);
    const nodes = results.map((r: any) => r.metric?.node).filter(Boolean).join(', ');

    switch (reduction) {
      case 'max':
        return results.reduce((acc, curr) =>
          Number(curr.value[1]) > Number(acc.value[1]) ? curr : acc
        );

      case 'min':
        return results.reduce((acc, curr) =>
          Number(curr.value[1]) < Number(acc.value[1]) ? curr : acc
        );

      case 'avg': {
        const avg = sum / results.length;
        return { metric: { node: nodes }, value: [results[0].value[0], String(avg)] };
      }

      case 'sum':
        return { metric: { node: nodes }, value: [results[0].value[0], String(sum)] };
      
    }
  }
}

export default MetricsAdapter;
