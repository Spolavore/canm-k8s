import * as AxiosService from '@/services/axios.service';

export type PrometheusResults = {
  metric: {
    node: string;
    [key: string]: string;
  };
  value: [number, string];
};

type QueryParams = {
  query: string;
  time_window?: string;
};

const promApi = process.env.PROMETHEUS_API_URL;

export async function instantQuery({ query, time_window }: QueryParams): Promise<PrometheusResults[]> {
  try {
    let expr = query;
    if(time_window){
     expr = query.replace(/\$\{time_window\}/g, time_window);
    }
    const url = `${promApi}/api/v1/query?query=${encodeURIComponent(expr)}`;
    const response = await AxiosService.get(url) as any;
    return response?.result;
  } catch (error) {
    console.error('[Prometheus Service]', error);
    throw error;
  }
}
