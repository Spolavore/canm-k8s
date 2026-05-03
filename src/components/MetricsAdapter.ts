import { instantQuery, PrometheusResults } from '@/services/prometheus.service';
import { CPU_USAGE_QUERY, NETWORK_RECEIVED_BYTES_QUERY, MEMORY_USAGE_QUERY } from '@/repositories/prometheus.queries';
import { ByteUnits, convertionCoefficients } from '@/utils/bytesUnits';
type AvailableReductions = 'max' | 'min' | 'avg' | 'sum';

class MetricsAdapter {
  /*
  * Returns the CPU use of each node in the cluster in percentage
  */
  async getNodesCpuUsage(
    time_window: string,
    reduction?: AvailableReductions
  ): Promise<unknown> {
    const results = await instantQuery({ query: CPU_USAGE_QUERY, time_window });

    if (results && reduction) {
      return this.reduct(results, reduction);
    }

    return results;
  }
  /*
  * Returns the receive bytes 
  */
  async getNodesNetworkReceivedBytes(
    time_window: string,
    reduction?: AvailableReductions,
    unit: ByteUnits = 'b',
  ): Promise<unknown> {
    const results = await instantQuery({ query: NETWORK_RECEIVED_BYTES_QUERY + `/ ${convertionCoefficients[unit]}` , time_window });

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
  ): Promise<unknown> {
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
