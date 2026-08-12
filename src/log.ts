/**
 * Dependency-free console logger.
 *
 * Everything goes to stderr except explicit `out()` calls, so the tool can be
 * piped (`ai-audit-lens --json > events.json`) without progress chatter
 * corrupting stdout.
 */

/** ASCII escape (0x1b), built at runtime so no raw control byte lives in source. */
const ESC = String.fromCharCode(27);

const useColor =
  process.stderr.isTTY === true &&
  process.env['NO_COLOR'] === undefined &&
  process.env['TERM'] !== 'dumb';

const paint = (code: string, s: string): string =>
  useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s;

export const style = {
  dim: (s: string) => paint('2', s),
  bold: (s: string) => paint('1', s),
  red: (s: string) => paint('31', s),
  green: (s: string) => paint('32', s),
  yellow: (s: string) => paint('33', s),
  blue: (s: string) => paint('34', s),
  cyan: (s: string) => paint('36', s),
};

let verbose = false;
export const setVerbose = (v: boolean): void => {
  verbose = v;
};

const write = (line: string): void => {
  process.stderr.write(line + '\n');
};

export const log = {
  /** Section heading. */
  step: (msg: string): void => write('\n' + style.bold(style.cyan('> ' + msg))),
  info: (msg: string): void => write('  ' + msg),
  ok: (msg: string): void => write('  ' + style.green('OK') + ' ' + msg),
  warn: (msg: string): void => write('  ' + style.yellow('!') + '  ' + msg),
  error: (msg: string): void => write('  ' + style.red('x') + '  ' + msg),
  /** Only emitted with `--verbose`; safe place for URLs and status codes. */
  debug: (msg: string): void => {
    if (verbose) write('  ' + style.dim('.  ' + msg));
  },
  /** Payload output on stdout. */
  out: (msg: string): void => {
    process.stdout.write(msg + '\n');
  },
};

const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string): string => s.replace(ANSI, '');

/**
 * Single-line progress that collapses to ordinary log lines on non-TTY
 * terminals (CI, piped output) instead of spraying carriage returns.
 */
export class Progress {
  private lastLen = 0;
  private readonly tty = process.stderr.isTTY === true;

  constructor(private readonly label: string) {}

  update(detail: string): void {
    const line = `  ${style.dim('.')}  ${this.label}: ${detail}`;
    if (!this.tty) {
      write(line);
      return;
    }
    process.stderr.write('\r' + ' '.repeat(this.lastLen) + '\r' + line);
    this.lastLen = stripAnsi(line).length;
  }

  done(detail: string): void {
    if (this.tty && this.lastLen > 0) {
      process.stderr.write('\r' + ' '.repeat(this.lastLen) + '\r');
      this.lastLen = 0;
    }
    log.ok(`${this.label}: ${detail}`);
  }
}
