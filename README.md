# codefort

Next-generation code isolation system.

## Technology

Code execution is sandboxed with [bubblewrap](https://github.com/containers/bubblewrap)
(one-shot `bwrap` jails per compile/run: no network, private pid/uts/ipc
namespaces, read-only system mounts, writable scratch dir only).

## API auth

Set `CODEFORT_TOKEN` to require `Authorization: Bearer <token>` on
`POST /v1/run` (executing code). `GET /v1/languages` stays public by design
(non-sensitive, used by container healthchecks). With no token configured the
API is open — only expose it on a private network then. The token is scrubbed
from the server environment at startup so it never appears in `/proc`.

## Limits

- Timeouts (`compileTimeout`/`runTimeout`) are enforced per process, and the
  whole job tree is SIGKILLed as a process group on timeout (no orphan leaks).
- Per-job ceilings via prlimit and watchdogs: virtual memory (4x requested MB,
  2 GB floor), CPU seconds, max 128 processes, and 64 MB aggregate writable
  scratch storage.
- Request sizes, timeouts, and memory values are clamped at the API boundary.
- At most 2 concurrent executions (503 when the executor is full) plus
  per-client rate limiting (429); container mem/cpu/pid limits are the hard
  backstops.

## Sandbox model

Fully unprivileged: the container runs as nobody with zero capabilities, and
each job gets a private user namespace (nobody-to-nobody) with all
capabilities dropped inside, no network, private pid/uts/ipc/cgroup
namespaces, cleared environment, fresh `/dev`, a private `/tmp` per job, and
read-only system mounts. Memory limits remain admission-only at the API
(the prlimit ceiling is on virtual memory); resident enforcement is at the
container level. Hosts that forbid unprivileged user namespaces cannot run
this (bubblewrap refuses); the Compose stack uses custom seccomp/AppArmor
profiles and fails closed if the host has not loaded the AppArmor profile;
a fresh `/proc` mount is skipped on
SELinux-enforcing hosts where it fails — the userns boundary still denies
cross-namespace `/proc/PID/environ` reads (verified).
