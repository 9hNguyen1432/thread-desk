import { execFile } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export class RunError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | string | null,
  ) {
    super(message);
  }
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** Runs a binary without a shell; arguments are passed verbatim. */
export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 15_000,
        maxBuffer: 64 * 1024 * 1024,
        env: opts.env ?? process.env,
        encoding: 'utf8',
        signal: opts.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code ?? null;
          reject(new RunError(`${bin} ${args.join(' ')} failed: ${error.message}`, stderr, code));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export async function runJson<T>(bin: string, args: string[], opts: RunOptions = {}): Promise<T> {
  const { stdout } = await run(bin, args, opts);
  return JSON.parse(stdout) as T;
}
