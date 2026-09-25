// Task permission profile (plan-coding-agent.md): inside a coding task's
// checkout, the routine work of coding — reading and editing files, running
// the package manager, tests, linters, local git — is auto-approved instead of
// raising an approval card per command. Anything that reaches OUTSIDE the
// workspace (other paths, the network beyond connectors, `git push`,
// destructive or privileged commands) still asks the requester.
//
// This decides auto-APPROVE vs ASK — never auto-deny. A false "ask" costs a
// click; a false "allow" would cost trust, so the rules lean conservative and
// every auto-approval is still visible in the run timeline.
import fs from 'node:fs';
import path from 'node:path';

export interface TaskPolicyContext {
  taskDir: string; // the project checkout the harness runs in
  stateDir: string; // the runner's per-thread state dir (mcp.json, connectors docs)
}

export interface PolicyDecision {
  allow: boolean;
  reason: string;
}

// Commands whose first word makes a shell segment routine coding work.
const ALLOWED_BINS = new Set([
  // package managers / runtimes
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'tsx', 'ts-node',
  'pip', 'pip3', 'python', 'python3', 'poetry', 'uv', 'pytest', 'pipenv',
  'go', 'gofmt', 'goimports', 'cargo', 'rustc', 'rustfmt',
  'composer', 'php', 'artisan', 'phpunit', 'pest',
  'bundle', 'ruby', 'rake', 'rails', 'gem',
  'mvn', 'gradle', 'gradlew', 'java', 'javac', 'kotlin',
  'dotnet', 'swift', 'make', 'cmake', 'ninja',
  // test/lint/build tools
  'vitest', 'jest', 'mocha', 'eslint', 'prettier', 'tsc', 'vite', 'webpack', 'esbuild', 'rollup',
  'ruff', 'black', 'flake8', 'mypy', 'golangci-lint', 'staticcheck',
  // read-only inspection
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd',
  'sed', 'awk', 'wc', 'sort', 'uniq', 'cut', 'tr', 'xargs', 'diff', 'jq', 'yq', 'tree', 'file', 'stat',
  'echo', 'printf', 'pwd', 'which', 'type', 'test', 'true', 'false', 'env', 'printenv', 'date', 'basename', 'dirname',
  'du', 'df', 'sleep', 'lsof', 'ps', 'paste', 'column', 'nl',
  // local dev-database clients (the data is the checkout's own dev store)
  'pg_isready', 'psql', 'mysql', 'sqlite3', 'redis-cli',
  // file ops (paths are checked separately)
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln', 'chmod',
  // vcs
  'git',
  // local containers (docker run is caught above)
  'docker', 'docker-compose',
  // shells for inline scripts (segments inside are not re-analyzed; the path
  // check below still applies to their text)
  'sh', 'bash', 'zsh',
]);

// Patterns that always ask, whatever else the command looks like.
const ALWAYS_ASK: { re: RegExp; why: string }[] = [
  { re: /(^|[\s;&|])sudo(\s|$)/, why: 'privilege escalation' },
  { re: /(^|[\s;&|])su(\s|$)/, why: 'privilege escalation' },
  { re: /\bgit\s+push\b/, why: 'git push is the MR step (request_mr)' },
  { re: /\bgit\s+remote\s+(add|set-url|remove|rm)\b/, why: 'changing remotes' },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fdx]|checkout\s+--\s+\.|restore\s+(--staged\s+)?\.|branch\s+-D|push\s+--force)/, why: 'mass-discarding local work' },
  { re: /\bgit\s+config\s+--global\b/, why: 'global git config' },
  { re: /\brm\s+(-[a-zA-Z]*\s+)*(\/|~|\$HOME|\.\.)/, why: 'rm outside the workspace' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python|node)\b/, why: 'piping downloads into a shell' },
  { re: /(^|[\s;&|])(curl|wget|nc|ncat|telnet|ssh|scp|sftp|rsync)(\s|$)/, why: 'network beyond connectors' },
  // docker compose / docker <inspect|logs|…> inside the checkout is how most
  // projects come up locally (the requester asked for docker-first setup);
  // bare `docker run` can mount anything and still asks.
  { re: /(^|[\s;&|])docker\s+run(\s|$)/, why: 'docker run can mount arbitrary paths' },
  { re: /(^|[\s;&|])(kubectl|helm|terraform|aws|gcloud|az|vercel|netlify|heroku|fly|flyctl)(\s|$)/, why: 'infrastructure tooling' },
  { re: /(^|[\s;&|])(gh|glab)(\s|$)/, why: 'forge CLI (use request_mr)' },
  { re: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b|\btwine\b|\bcargo\s+publish\b|\bgem\s+push\b/, why: 'publishing packages' },
  { re: /(^|[\s;&|])(shutdown|reboot|halt|mkfs|fdisk|diskutil|launchctl|systemctl|crontab|open|xdg-open|osascript)(\s|$)/, why: 'system-level action' },
  { re: /\bkill\s+-9\s+-1\b|\bkillall\b|\bpkill\b/, why: 'killing arbitrary processes' },
  { re: /(^|[\s;&|])dd(\s|$)/, why: 'raw disk write' },
  { re: /\bchmod\s+[0-7]*[2367][0-7]*\s+\//, why: 'chmod on system paths' },
  { re: />\s*\/(etc|usr|bin|sbin|var|System|Library)\//, why: 'writing to system paths' },
  { re: /\$\(\s*(curl|wget)\b/, why: 'downloading into a command' },
];

// Path prefixes that are fine to touch from a task shell.
function allowedRoots(ctx: TaskPolicyContext): string[] {
  const roots = [ctx.taskDir, ctx.stateDir, '/tmp', '/private/tmp', '/var/folders', '/dev/null', '/dev/stdout', '/dev/stderr'];
  const home = process.env.HOME || '';
  // Toolchain caches/binaries that package managers touch legitimately.
  if (home) {
    roots.push(
      path.join(home, '.npm'), path.join(home, '.cache'), path.join(home, '.pnpm-store'), path.join(home, '.yarn'),
      path.join(home, '.cargo'), path.join(home, 'go'), path.join(home, '.local'), path.join(home, '.nvm'),
      path.join(home, '.composer'), path.join(home, '.gem'), path.join(home, '.m2'), path.join(home, '.gradle'),
      path.join(home, 'Library', 'Caches'), path.join(home, 'Library', 'pnpm'),
    );
  }
  roots.push('/usr', '/bin', '/sbin', '/opt', '/etc/hosts', '/System/Library', '/Library/Developer', '/Applications/Xcode.app');
  return roots.map((r) => path.resolve(r));
}

// Locations that count as a real touch even when the path does not exist on
// this machine: home directories (secret stores like ~/.ssh live there) and
// system roots. The "nonexistent ⇒ prose" heuristic below must never wave
// through a probe of ~/.ssh/id_rsa just because the host has no such file.
function sensitiveRoots(): string[] {
  const roots = ['/etc', '/private/etc', '/Users', '/home', '/root', '/Applications', '/Library', '/System'];
  const home = process.env.HOME || '';
  if (home) roots.push(home);
  return roots.map((r) => path.resolve(r));
}

function insideAny(p: string, roots: string[]): boolean {
  const abs = path.resolve(p);
  return roots.some((r) => abs === r || abs.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

// pathsIn extracts absolute and home-relative path tokens from a command.
function pathsIn(cmd: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s='"`(])((?:\/|~\/|~$)[^\s'"`;|&()<>]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    let p = m[1];
    if (p.startsWith('~')) p = (process.env.HOME || '') + p.slice(1);
    // Strip a trailing punctuation the regex may have caught.
    p = p.replace(/[.,:]+$/, '');
    // A bare "/" is prose ("approved / pending") or a delimiter argument
    // (`cut -d'/'`) — a real touch of the root is caught by ALWAYS_ASK.
    if (p && p !== '/') out.push(p);
  }
  return out;
}

// Commands whose heredoc body is CODE they will execute — those bodies stay
// under every rule. For anything else (`git commit -F - <<EOF`, `cat > x
// <<EOF`) the body is stdin DATA: commit prose mentioning "/leave/overview"
// must not read as a filesystem touch.
const HEREDOC_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'python', 'python3', 'node', 'php', 'ruby', 'perl', 'deno', 'tsx']);

// stripHeredocs removes here-doc bodies (<< TAG … TAG) from the analyzed
// text, keeping the marker line (so the receiving command is still checked).
// With keepInterpreterBodies, bodies destined for an interpreter stay — the
// PATH check must still see `open('/etc/passwd')` inside a python heredoc —
// but segment analysis never keeps them: python/php code is not shell, and
// treating its lines as commands manufactured false asks ("import", "$e").
export function stripHeredocs(cmd: string, keepInterpreterBodies: boolean): string {
  const re = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n/g;
  let out = '';
  let idx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    // Defensive: exec never yields a match before lastIndex, which we pin to
    // idx after every consume — kept as a guard, unreachable in practice.
    /* v8 ignore next */
    if (m.index < idx) continue; // marker inside a body we already consumed
    const tag = m[2];
    const bodyStart = m.index + m[0].length;
    let end = -1;
    for (let i = cmd.indexOf('\n' + tag, bodyStart - 1); i !== -1; i = cmd.indexOf('\n' + tag, i + 1)) {
      const after = cmd[i + 1 + tag.length];
      if (after === undefined || after === '\n' || after === '\r' || after === ' ') {
        end = i;
        break;
      }
    }
    if (end === -1) break; // unterminated — analyze the rest verbatim
    const head = cmd.slice(idx, m.index);
    // split() on a string always yields at least one element; the ?? '' is a
    // type-level guard only.
    /* v8 ignore next */
    const lastSeg = head.split(/\n|&&|\|\||;|\|/).pop() ?? '';
    const target = path.basename(firstWord(lastSeg));
    out += cmd.slice(idx, m.index) + m[0];
    if (keepInterpreterBodies && HEREDOC_INTERPRETERS.has(target)) {
      out += cmd.slice(bodyStart, end + 1 + tag.length); // code: keep it
    }
    idx = end + 1 + tag.length;
    re.lastIndex = idx;
  }
  return out + cmd.slice(idx);
}

// splitSegments breaks a shell line on the operators between commands —
// but never inside quotes: `grep "a\|b"` is ONE command, and shredding the
// pattern used to surface garbage "commands" that forced approval cards.
function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: "'" | '"' | '' = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q && (q === "'" || cmd[i - 1] !== '\\')) q = '';
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      cur += c + cmd[i + 1]; // escaped char (`cut -d\\|`): never an operator
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === '\n' || c === ';') {
      out.push(cur);
      cur = '';
      continue;
    }
    if (c === '&' && cmd[i + 1] === '&') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === '|') {
      out.push(cur);
      cur = '';
      if (cmd[i + 1] === '|') i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Control-flow openers that carry a nested command in the SAME segment
// ("do cp a b") — skip the keyword and check what follows.
const KEYWORDS_WITH_COMMAND = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do']);
// Syntax-only words a segment may consist of entirely.
const KEYWORDS_BARE = new Set(['for', 'done', 'fi', 'esac', 'case', 'in', '[', '[[', '((', ':', '{', '}', ')']);

function firstWord(seg: string): string {
  // Skip leading VAR=value assignments, wrappers, and control-flow keywords.
  const tokens = seg.split(/\s+/).filter(Boolean);
  let i = 0;
  for (;;) {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    while (i < tokens.length && ['time', 'nohup', 'exec', 'command', 'nice'].includes(tokens[i])) i++;
    if (i < tokens.length && KEYWORDS_WITH_COMMAND.has(tokens[i])) {
      i++;
      continue;
    }
    break;
  }
  let w = tokens[i] ?? '';
  while (w.startsWith('(') || w.startsWith('{')) w = w.slice(1); // subshell/group opener
  while (w.endsWith(')') || w.endsWith('}') || w.endsWith(';')) w = w.slice(0, -1); // closers glued on: `|| true)`
  return w;
}

export function bashAllowed(command: string, ctx: TaskPolicyContext): PolicyDecision {
  const cmd = command.trim();
  if (!cmd) return { allow: false, reason: 'empty command' };
  if (cmd.length > 4000) return { allow: false, reason: 'very long command' };
  for (const { re, why } of ALWAYS_ASK) {
    if (re.test(cmd)) return { allow: false, reason: why };
  }
  // Analyze with heredoc DATA removed so commit messages and file payloads
  // don't read as paths or commands. ALWAYS_ASK above saw the full text; the
  // path check still sees interpreter bodies (they are code that can touch
  // files), while segment analysis sees no heredoc bodies at all.
  const roots = allowedRoots(ctx);
  const sensitive = sensitiveRoots();
  for (const p of pathsIn(stripHeredocs(cmd, true))) {
    if (insideAny(p, roots)) continue;
    if (path.resolve(p) === '/') continue; // "//" and friends: prose, not root access
    // Only real filesystem locations count: a slash-token whose path AND
    // parent don't exist (`/api/people/employees` in a tinker script) is a
    // route or prose, not a touch — and a nonexistent direct child of "/"
    // ("/8" from code text) is prose too. Writes need an existing parent.
    // Sensitive roots skip this: they always read as a touch.
    if (!insideAny(p, sensitive)) {
      try {
        const parent = path.dirname(path.resolve(p));
        if (!fs.existsSync(p) && (parent === '/' || !fs.existsSync(parent))) continue;
      } catch {
        // treat unstatable paths as real
      }
    }
    return { allow: false, reason: `touches ${p} outside the workspace` };
  }
  // Track cd across segments so `cd backend && …; cd ../frontend && …`
  // resolves every hop against where the shell actually is by then.
  let cwd = ctx.taskDir;
  for (const seg of splitSegments(stripHeredocs(cmd, false))) {
    const cdm = /^cd(?:\s+(.+))?$/.exec(seg.trim());
    if (cdm) {
      const target = (cdm[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
      if (!target) continue; // bare cd → $HOME (historic behavior: allowed)
      if (target === '-') return { allow: false, reason: 'cd out of the workspace' };
      const resolved = path.resolve(cwd, target.startsWith('~') ? (process.env.HOME || '') + target.slice(1) : target);
      if (!insideAny(resolved, [ctx.taskDir, ctx.stateDir])) {
        return { allow: false, reason: 'cd out of the workspace' };
      }
      cwd = resolved;
      continue;
    }
    const word = firstWord(seg);
    if (!word) continue;
    if (['cd', 'export', 'set', 'unset', 'source', '.'].includes(word) || KEYWORDS_BARE.has(word)) continue;
    const base = path.basename(word);
    const relativeScript =
      word.startsWith('./') || word.startsWith('bin/') || word.startsWith('scripts/') || word.startsWith('vendor/bin/') || word.startsWith('node_modules/.bin/');
    if (!ALLOWED_BINS.has(base) && !relativeScript) {
      return { allow: false, reason: `unrecognized command "${word}"` };
    }
  }
  return { allow: true, reason: 'routine work inside the workspace' };
}

// taskPolicyAllows is the approval_prompt hook: harness tool + input → allow
// (auto-approve) or ask (raise the card).
export function taskPolicyAllows(
  toolName: string,
  input: Record<string, unknown>,
  ctx: TaskPolicyContext,
): PolicyDecision {
  const str = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const roots = [ctx.taskDir, ctx.stateDir, '/tmp', '/private/tmp'];
  const pathOk = (p: string): boolean => {
    if (!p) return true; // tools default to cwd = the workspace
    const abs = path.isAbsolute(p) ? p : path.resolve(ctx.taskDir, p);
    return insideAny(abs, roots);
  };
  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const p = str('file_path');
      return pathOk(p)
        ? { allow: true, reason: 'file inside the workspace' }
        : { allow: false, reason: `file outside the workspace: ${p}` };
    }
    case 'NotebookEdit': {
      const p = str('notebook_path');
      return pathOk(p) ? { allow: true, reason: 'notebook inside the workspace' } : { allow: false, reason: 'notebook outside the workspace' };
    }
    case 'Glob':
    case 'Grep': {
      const p = str('path');
      return pathOk(p) ? { allow: true, reason: 'search inside the workspace' } : { allow: false, reason: 'search outside the workspace' };
    }
    case 'Bash':
      return bashAllowed(str('command'), ctx);
    default:
      return { allow: false, reason: `${toolName} is not part of the task profile` };
  }
}
