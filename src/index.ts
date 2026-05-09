import 'dotenv/config';
import { loadProviderConfig } from '@lib/KubernetesClient';
import MigratorOrchestrator from '@components/MigratorOrchestrator';
import { MigrationConfig } from '@/types';

const migrationConfig: MigrationConfig = {
  highNodePool: process.env.HIGH_NODE_POOL as string,
  lowNodePool: process.env.LOW_NODE_POOL as string,
  lowScoreThreshold: parseFloat(process.env.LOW_SCORE_THRESHOLD ?? '0.3'),
  highScoreThreshold: parseFloat(process.env.HIGH_SCORE_THRESHOLD ?? '0.7'),
  ...(process.env.MIGRATION_POLICY && { policy: process.env.MIGRATION_POLICY as MigrationConfig['policy'] }),
  ...(process.env.CHECK_INTERVAL && { checkInterval: parseInt(process.env.CHECK_INTERVAL) }),
};

const providerConfig = loadProviderConfig();
const migrator = new MigratorOrchestrator(
  migrationConfig,
  { cpu: process.env.CPU_WEIGHT, memory: process.env.MEMORY_WEIGHT, network: process.env.NETWORK_WEIGHT },
  'gke',
  providerConfig
);

async function main(): Promise<void> {
  await migrator.start();
}

main();
