import 'zod-openapi/extend';
import { z } from 'zod';
import { languages } from './languages';
import { mkdtemp, readdir, lstat, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { rm } from 'fs/promises';
import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const ExecuteOptions = z.object({
  language: z.enum(languages.map((x) => x.id) as [string, ...string[]]),
  code: z.string().max(1_000_000),
  stdin: z.string().max(1_000_000).default(''),
  compileTimeout: z.number().min(1).max(120_000),
  // NOTE: memory limits are admission-only today (clamped + documented in the
  // API schema). Enforcement happens at the container level via compose
  // mem_limit. Per-job cgroup enforcement is a known gap.
  compileMemoryLimit: z.number().int().min(0).max(4096),
  runTimeout: z.number().min(1).max(120_000),
  runMemoryLimit: z.number().int().min(0).max(4096),
});

const projectRootPath = resolve(import.meta.dir, '../');

export const ExecuteSchema = z.object({
  exitCode: z.number().openapi({
    description: 'The numeric exit code given by the code when executed.',
  }),
  stdout: z.string().openapi({
    description: 'The stdout given by the code when executed.',
  }),
  stderr: z.string().openapi({
    description: 'The stderr given by the code when executed.',
  }),
  stats: z.object({
    compile: z
      .object({
        realTime: z.number().openapi({
          description: 'The amount of time taken to compile the program, in milliseconds.',
        }),
        stdout: z.string(),
        stderr: z.string(),
      })
      .nullable()
      .openapi({
        description: 'Information about the compile process, if applicable to the language.',
        example: {
          realTime: 9,
          stdout: 'Compiled successfully!',
          stderr: '',
        },
      }),
    run: z
      .object({
        realTime: z.number(),
      })
      .openapi({
        description: 'Information about the run process.',
        example: {
          realTime: 8,
        },
      }),
  }),
});

// Helper function to get bubblewrap path
function getBwrapPath() {
  // First try 'bubblewrap', then fallback to 'bwrap'
  const bubblewrapPath = Bun.which('bubblewrap');
  if (bubblewrapPath) return bubblewrapPath;

  const bwrapPath = Bun.which('bwrap');
  if (bwrapPath) return bwrapPath;

  throw new Error('Bubblewrap not found. Please install it using your system package manager.');
}

// Sandbox identity: fully unprivileged. The container itself runs as nobody
// (see Dockerfile USER), and every job gets a private user namespace mapping
// that nobody to jail-nobody — so jailed code has no host uid 0 anywhere.
const SANDBOX_UID = 65534;
const SANDBOX_GID = 65534;

// Per-job resource ceilings enforced with prlimit(1); inherited by children.
// PID and storage totals are watched separately because RLIMIT_NPROC and
// RLIMIT_FSIZE are shared/per-file limits rather than per-job boundaries.
const MAX_JOB_PROCESSES = 128;
const MAX_FSIZE_BYTES = 64 * 1024 * 1024;
const AS_MULTIPLIER = 4; // virtual-memory headroom over the requested MB...
const AS_FLOOR_MB = 2048; // ...with a floor so runtimes don't false-trip

function resourceLimits(memoryMb: number, timeoutMs: number): string[] {
  const asBytes = Math.max(memoryMb * AS_MULTIPLIER, AS_FLOOR_MB) * 1024 * 1024;
  const cpuSec = Math.ceil(timeoutMs / 1000) + 5;
  return ['prlimit', `--as=${asBytes}`, `--cpu=${cpuSec}`, `--fsize=${MAX_FSIZE_BYTES}`, '--'];
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await lstat(child)).size;
  }
  return total;
}

async function processGroupSize(groupId: number): Promise<number> {
  let total = 0;
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === groupId) total++;
    } catch {
      // Processes can exit while /proc is being inspected.
    }
  }
  return total;
}

// Helper function to create bubblewrap args with minimal permissions.
// Verified matrix: every flag here was tested against all 5 languages.
function createBwrapArgs(
  tempDir: string,
  language: (typeof languages)[number],
  command: string,
  limits: { memoryMb: number; timeoutMs: number },
) {
  const args = [
    // New process group so a timeout can SIGKILL the whole job tree
    // (Bun can only signal the direct child; orphaned grandchildren would
    // otherwise leak past the timeout and eat pids).
    'setsid',

    ...resourceLimits(limits.memoryMb, limits.timeoutMs),

    // Base bubblewrap command
    getBwrapPath(),

    // Unprivileged sandbox: private userns nobody->nobody, no network,
    // private pid/uts/ipc/cgroup namespaces.
    '--unshare-user',
    '--uid',
    String(SANDBOX_UID),
    '--gid',
    String(SANDBOX_GID),
    '--unshare-net',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--unshare-cgroup',

    '--die-with-parent',

    // Belt and braces: the userns already scopes capabilities, but drop
    // them all explicitly for the jailed process.
    '--cap-drop',
    'ALL',

    // No inherited environment (PATH/HOME/TMPDIR set below). Among other
    // things this keeps server secrets out of the jail's /proc/self/environ.
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/local/bin:/usr/bin:/bin',
    '--setenv',
    'HOME',
    tempDir,
    '--setenv',
    'TMPDIR',
    tempDir,

    // Mount read-only directories
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/lib',
    '/lib',
  ];

  // Only include /lib64 if it exists (merged-usr systems need the loader).
  if (existsSync('/lib64')) {
    args.push('--ro-bind', '/lib64', '/lib64');
  }

  // Continue with other paths
  args.push('--ro-bind', '/bin', '/bin', '--ro-bind', '/etc', '/etc');

  // NOTE: a fresh `--proc` fails to mount alongside --unshare-pid on
  // SELinux-enforcing hosts, so the outer /proc stays visible. This is safe
  // here: the userns boundary denies cross-namespace environ reads
  // (verified: nobody-in-jail gets EACCES on server /proc/PID/environ),
  // the server scrubs CODEFORT_TOKEN from its own environment at startup,
  // and only cmdlines (no secrets) remain visible.
  args.push('--ro-bind', '/proc', '/proc');

  // Fresh minimal /dev (null, zero, full, random, urandom, tty, pts).
  // Do NOT --ro-bind the outer /dev: its device nodes are unusable inside
  // the jail (Bun aborts opening /dev/urandom with EACCES), breaking the
  // javascript/typescript runtimes.
  args.push('--dev', '/dev');

  // Private /tmp per job (fresh tmpfs hides other jobs' scratch dirs),
  // then bind the job's own temp dir writable inside it.
  // Private /tmp per job (fresh tmpfs hides other jobs' scratch dirs),
  // then the job's own temp dir is bound writable inside it below.
  args.push('--tmpfs', '/tmp');

  args.push('--ro-bind', resolve(projectRootPath, './languages'), resolve(projectRootPath, './languages'));

  // Mount needed directories from language.meta.neededDirs
  for (const dir of language.meta.neededDirs) {
    if (existsSync(dir)) {
      args.push('--ro-bind', dir, dir);
    }
  }

  // Read-write access to the temporary directory. Owned by the server uid
  // (nobody), which the userns maps to jail-nobody — writable inside.
  args.push('--bind', tempDir, tempDir);

  args.push('--new-session');

  // Add the command to run (resolved outside the jail).
  args.push(Bun.which('bash') || '/bin/bash', command);

  return args;
}

type Subprocess = ReturnType<typeof Bun.spawn>;

/** SIGKILL the whole job tree. The jail runs under `setsid`, so signaling
 * the negative pid hits bwrap, the shell, and orphaned grandchildren that
 * Bun's child-only kill would leave behind to eat pids. */
function killTree(proc: Subprocess) {
  const pid = proc.pid;
  if (pid) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // Fall through to direct kill (e.g. already exited, or no permission).
    }
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    // Already exited.
  }
}

async function runSandboxed(
  args: string[],
  opts: { cwd: string; stdin?: string; timeoutMs: number; storageDir: string },
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; signalCode: string | null }> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    stdin: opts.stdin !== undefined ? new Response(opts.stdin) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    maxBuffer: 2 * 1024 * 1024, // 2mb
  });

  let timedOut = false;
  let resourceLimitExceeded = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(proc);
  }, opts.timeoutMs);
  let monitoring = false;
  const resourceMonitor = setInterval(() => {
    if (monitoring) return;
    monitoring = true;
    void Promise.all([directorySize(opts.storageDir), processGroupSize(proc.pid)])
      .then(([bytes, processes]) => {
        if (bytes > MAX_FSIZE_BYTES || processes > MAX_JOB_PROCESSES) {
          resourceLimitExceeded = true;
          killTree(proc);
        }
      })
      .catch(() => {
        resourceLimitExceeded = true;
        killTree(proc);
      })
      .finally(() => {
        monitoring = false;
      });
  }, 50);

  try {
    const result = await proc.exited;
    return {
      exitCode: timedOut ? 124 : (result ?? 1),
      stdout: await new Response(proc.stdout).text(),
      stderr:
        (await new Response(proc.stderr).text()) +
        (resourceLimitExceeded ? '\nExecution exceeded its per-job resource limit.\n' : ''),
      timedOut,
      signalCode: proc.signalCode,
    };
  } finally {
    clearTimeout(timer);
    clearInterval(resourceMonitor);
  }
}

export async function execute(optionsRaw: z.infer<typeof ExecuteOptions>): Promise<z.infer<typeof ExecuteSchema>> {
  const options = ExecuteOptions.parse(optionsRaw); // we might make the zod schema change the values

  const language = languages.find((x) => x.id.toLowerCase() === options.language.toLowerCase());
  if (!language) throw Error('Language not found');

  const tempDir = await mkdtemp(join(tmpdir(), 'codefort-exec-'));

  try {
    // write code
    await writeFile(join(tempDir, language.meta.fileName), options.code);

    let compileTime = 0;
    let compileStdout = '';
    let compileStderr = '';
    let compileExitCode: number | null = null;

    if (language.compilePath) {
      const startCompileTime = Date.now();
      const compileCommand = resolve(projectRootPath, './languages/', language.id, language.compilePath);
      const compileArgs = createBwrapArgs(tempDir, language, compileCommand, {
        memoryMb: options.compileMemoryLimit,
        timeoutMs: options.compileTimeout,
      });

      const compile = await runSandboxed(compileArgs, {
        cwd: tempDir,
        timeoutMs: options.compileTimeout,
        storageDir: tempDir,
      });
      compileExitCode = compile.exitCode;
      compileTime = Date.now() - startCompileTime;
      compileStdout = compile.stdout;
      compileStderr = compile.stderr;

      // Don't burn a run on a failed compile; report the compile outcome.
      if (compileExitCode !== 0) {
        return {
          exitCode: compileExitCode ?? 124,
          stdout: compileStdout,
          stderr: compileStderr,
          stats: {
            compile: {
              realTime: compileTime,
              stdout: compileStdout,
              stderr: compileStderr,
            },
            run: {
              realTime: 0,
            },
          },
        };
      }
    }

    const runStartTime = Date.now();
    const runCommand = resolve(projectRootPath, './languages/', language.id, language.runPath);
    const runArgs = createBwrapArgs(tempDir, language, runCommand, {
      memoryMb: options.runMemoryLimit,
      timeoutMs: options.runTimeout,
    });

    const run = await runSandboxed(runArgs, {
      cwd: tempDir,
      stdin: options.stdin,
      timeoutMs: options.runTimeout,
      storageDir: tempDir,
    });

    // Never log options: it contains the submitted source code.
    console.log({ language: options.language, compileTimeout: options.compileTimeout, runTimeout: options.runTimeout });

    return {
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      stats: {
        compile: language.compilePath
          ? {
              realTime: compileTime,
              stdout: compileStdout,
              stderr: compileStderr,
            }
          : null,
        run: {
          realTime: Date.now() - runStartTime,
        },
      },
    };
  } finally {
    try {
      await rm(tempDir, {
        recursive: true,
        force: true,
      });
    } catch (e) {
      // Sandbox mounts can briefly outlive the child process. Do not turn a
      // completed execution into HTTP 500 just because cleanup was denied.
      console.error('Failed to clean execution directory:', e);
    }
  }
}
