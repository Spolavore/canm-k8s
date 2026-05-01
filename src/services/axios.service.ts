import axios, { AxiosRequestConfig } from 'axios';

const get = async (url: string, config: AxiosRequestConfig = {}): Promise<unknown> => {
  try {
    const response = await axios.get(url, config);
    return response.data?.data;
  } catch (error) {
    console.error(`[Axios Request] - ${error}`);
  }
};

export { get };
