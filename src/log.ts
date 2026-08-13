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

export type LogLevel = 'step' | 'info' | 'ok' | 'warn' | 'error' | 'debug' | 'progress';

/**
 * Structured log sink.
 *
 * The CLI leaves this unset and everything goes to stderr. The Electron main
 * process installs a sink so the same core modules stream their progress into
 * the GUI over IPC — no rewriting, and no ANSI escapes leaking into the DOM.
 */
export type LogSink = (level: LogLevel, message: string) => void;

let sink: LogSink | undefined;
export const setLogSink = (fn: LogSink | undefined): void => {
  sink = fn;
};

const write = (line: string): void => {
  process.stderr.write(line + '\n');
};

/** Route through the sink when one is installed, otherwise to stderr. */
const emit = (level: LogLevel, plain: string, decorated: string): void => {
  if (sink) {
    sink(level, plain);
    return;
  }
  write(decorated);
};

export const log = {
  /** Section heading. */
  step: (msg: string): void => emit('step', msg, '\n' + style.bold(style.cyan('> ' + msg))),
  info: (msg: string): void => emit('info', msg, '  ' + msg),
  ok: (msg: string): void => emit('ok', msg, '  ' + style.green('OK') + ' ' + msg),
  warn: (msg: string): void => emit('warn', msg, '  ' + style.yellow('!') + '  ' + msg),
  error: (msg: string): void => emit('error', msg, '  ' + style.red('x') + '  ' + msg),
  /** Only emitted with `--verbose`; safe place for URLs and status codes. */
  debug: (msg: string): void => {
    if (verbose) emit('debug', msg, '  ' + style.dim('.  ' + msg));
  },
  /** Payload output on stdout. Never routed to the sink. */
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
    // A GUI replaces the line in place, so a sink gets one 'progress' event
    // per tick rather than the carriage-return dance a terminal needs.
    if (sink) {
      sink('progress', `${this.label}: ${detail}`);
      return;
    }
    const line = `  ${style.dim('.')}  ${this.label}: ${detail}`;
    if (!this.tty) {
      write(line);
      return;
    }
    process.stderr.write('\r' + ' '.repeat(this.lastLen) + '\r' + line);
    this.lastLen = stripAnsi(line).length;
  }

  done(detail: string): void {
    if (!sink && this.tty && this.lastLen > 0) {
      process.stderr.write('\r' + ' '.repeat(this.lastLen) + '\r');
      this.lastLen = 0;
    }
    log.ok(`${this.label}: ${detail}`);
  }
}
