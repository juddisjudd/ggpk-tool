import chalk from 'chalk';

export const logger = {
  info: (message: string, ...args: any[]) => {
    console.log(chalk.blue('[i]'), message, ...args);
  },

  success: (message: string, ...args: any[]) => {
    console.log(chalk.green('[+]'), message, ...args);
  },

  warn: (message: string, ...args: any[]) => {
    console.warn(chalk.yellow('[!]'), message, ...args);
  },

  error: (message: string, error?: any) => {
    console.error(chalk.red('[x]'), message);
    if (error) {
      console.error(chalk.red(error.stack || error.message || error));
    }
  },

  debug: (message: string, ...args: any[]) => {
    if (process.env.DEBUG) {
      console.log(chalk.gray('[d]'), message, ...args);
    }
  },

  section: (title: string) => {
    console.log('\n' + chalk.cyan.bold(`━━━ ${title} ━━━`) + '\n');
  },

  step: (step: number, total: number, message: string) => {
    console.log(chalk.cyan(`[${step}/${total}]`), message);
  },
  
  /**
   * Render a progress bar inline (overwrites current line)
   */
  progress: (current: number, total: number, options: {
    phase?: string;
    currentFile?: string;
    rate?: string;
    elapsed?: number;
    width?: number;
  } = {}) => {
    const { phase = '', currentFile = '', rate = '', elapsed, width = 30 } = options;
    
    // Calculate percentage
    const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    
    // Build progress bar
    const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
    
    // Format elapsed time
    const elapsedStr = elapsed ? formatDuration(elapsed) : '';
    
    // Truncate file name to fit
    const maxFileLen = 50;
    const truncatedFile = currentFile.length > maxFileLen 
      ? '...' + currentFile.slice(-maxFileLen + 3) 
      : currentFile;
    
    // Build status line
    const phaseBadge = phase ? chalk.cyan(`[${phase}]`) + ' ' : '';
    const stats = [
      `${current.toLocaleString()}/${total.toLocaleString()}`,
      rate,
      elapsedStr
    ].filter(Boolean).join(' │ ');
    
    const line = `\r${phaseBadge}${bar} ${percent}% │ ${stats}`;
    
    // Write with file on second line if present
    process.stdout.write(line + ' '.repeat(Math.max(0, 80 - line.length)));
    if (truncatedFile) {
      process.stdout.write(`\n  ${chalk.gray(truncatedFile)}` + ' '.repeat(Math.max(0, 70 - truncatedFile.length)) + '\x1b[1A');
    }
  },
  
  /**
   * Clear the progress line
   */
  clearProgress: () => {
    process.stdout.write('\r' + ' '.repeat(100) + '\r');
    process.stdout.write('\n' + ' '.repeat(100) + '\x1b[1A\r');
  }
};

/**
 * Format duration in ms to human readable string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}
