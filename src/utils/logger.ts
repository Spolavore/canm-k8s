type LogLevel = 'log' | 'info' | 'warn' | 'error';

export function logger(component: string, message: string, level: LogLevel = 'log'): void {
  console[level](`[${component}] ${message}`);
}
