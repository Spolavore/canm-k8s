
const PROMETHEUS_JOB = process.env.PROMETHEUS_JOB ?? 'kubernetes-nodes-metrics';

export const CPU_USAGE_QUERY = [
  `sum(rate(container_cpu_usage_seconds_total{job="${PROMETHEUS_JOB}",id="/"}[\${time_window}])) by (node)`,
  `/`,
  `sum(machine_cpu_cores{job="${PROMETHEUS_JOB}"}) by (node)`,
  `* 100`,
].join(' ');

export const MEMORY_USAGE_QUERY = [
  `(sum(container_memory_working_set_bytes{job="${PROMETHEUS_JOB}", id="/"}) by (node)`,
  `/`,
  `sum(machine_memory_bytes{job="${PROMETHEUS_JOB}"}) by (node))`,
  `* 100`,
].join(' ');