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
    ...(process.env.CHECK_INTERVAL && { checkInterval: process.env.CHECK_INTERVAL }),
    ...(process.env.HIGH_NODE_COOL_DOWN && { highNodeCoolDown: process.env.HIGH_NODE_COOL_DOWN }),
    ...(process.env.LOW_NODE_COOL_DOWN && { lowNodeCoolDown: process.env.LOW_NODE_COOL_DOWN }),
    ...(process.env.LOW_POOL_TIME_WINDOW_EVAL && { lowPoolTimeWindowEval: process.env.LOW_POOL_TIME_WINDOW_EVAL }),
    ...(process.env.HIGH_POOL_TIME_WINDOW_EVAL && { highPoolTimeWindowEval: process.env.HIGH_POOL_TIME_WINDOW_EVAL }),
    ...(process.env.CANM_EVAL_COOLDOWN && { canmEvalCoolDown: process.env.CANM_EVAL_COOLDOWN }),
    ...(process.env.DRAIN_PACED && { drainPaced: process.env.DRAIN_PACED == 'TRUE' ? true : false }),
    ...(process.env.DRAIN_BATCH_TIMEOUT && { drainBatchTimeout: process.env.DRAIN_BATCH_TIMEOUT }),
    ...(process.env.DRAIN_BATCH_SIZE && { drainBatchSize: Number(process.env.DRAIN_BATCH_SIZE) }),
};

const providerConfig = loadProviderConfig();
const migrator = new MigratorOrchestrator(
    migrationConfig,
    { cpu: process.env.CPU_WEIGHT, memory: process.env.MEMORY_WEIGHT },
    'gke',
    providerConfig,
);

async function main(): Promise<void> {
    await migrator.start();
}

main();
