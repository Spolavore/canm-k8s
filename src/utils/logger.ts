type LogLevel = 'log' | 'info' | 'warn' | 'error';

export function logger(component: string, message: string, level: LogLevel = 'log', bool: boolean = true): void {
  if(bool) console[level](`[${component}] ${message}`);
}
