import axios, { AxiosRequestConfig } from 'axios';
import { logger } from '@/utils';

const COMPONENT = 'Axios Request';

const get = async (url: string, config: AxiosRequestConfig = {}): Promise<unknown> => {
  try {
    const response = await axios.get(url, config);
    return response.data?.data;
  } catch (error) {
    logger(COMPONENT, `${error}`, 'error');
  }
};

export { get };
