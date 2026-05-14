import * as AxiosService from '@/services/axios.service';
import { logger } from '@/utils';

const COMPONENT = 'Prometheus Service';

export type PrometheusResults = {
  metric: {
    node: string;
    [key: string]: string;
  };
  value: [number, string];
};

type QueryParams = {
  query: string;
  timeWindow?: string;
};

const promApi = process.env.PROMETHEUS_API_URL;

export async function instantQuery({ query, timeWindow }: QueryParams): Promise<PrometheusResults[]> {
  try {
    let expr = query;
    if(timeWindow){
     expr = query.replace(/\$\{time_window\}/g, timeWindow);
    }
    const url = `${promApi}/api/v1/query?query=${encodeURIComponent(expr)}`;
    const response = await AxiosService.get(url) as any;
    return response?.result;
  } catch (error) {
    logger(COMPONENT, `${error}`, 'error');
    throw error;
  }
}
