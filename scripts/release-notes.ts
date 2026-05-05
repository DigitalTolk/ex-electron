// Generates release notes for the current tag and writes them to stdout.
//
// If AWS credentials are present, asks Claude (via Bedrock, anthropic.claude-
// sonnet-4-6 in eu-north-1 by default) to summarise the commit range into
// grouped, narrative bullets. Otherwise falls back to a plain commit list so
// the workflow never breaks just because credentials are missing.
//
// Always appends a "Full changelog" compare URL pointing at the GitHub repo.
// Wired into release.yml's GitHub Release step via body_path.
import { execFileSync } from 'node:child_process';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

const DEFAULT_BEDROCK_MODEL = 'anthropic.claude-sonnet-4-6';
const DEFAULT_AWS_REGION = 'eu-north-1';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function tryGit(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function currentTag(): string {
  return process.env.GITHUB_REF_NAME ?? git(['describe', '--exact-match', '--tags', 'HEAD']);
}

function previousTag(tag: string): string | null {
  return tryGit(['describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`]);
}

function commitsBetween(prev: string | null, tag: string): string {
  const range = prev ? `${prev}..${tag}` : tag;
  return git(['log', range, '--pretty=format:- %s (%h)']);
}

async function summariseWithClaude(commits: string, tag: string): Promise<string | null> {
  // The Bedrock SDK auto-reads AWS_BEARER_TOKEN_BEDROCK (long-term Bedrock API
  // key). If it isn't set, fall back to the plain commit list so the release
  // workflow keeps working.
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
    return null;
  }
  const prompt = `You are writing release notes for ex-electron, a desktop chat client built on Electron.

Output GitHub-flavored Markdown. Generate concise notes from this commit list, following these rules:
- Group into sections using level-3 headings: ### Features, ### Fixes, ### Internal. Only include sections that have entries.
- One bullet per logical change. Combine related commits when it reads better.
- Each bullet should explain what changed and (when relevant) why it matters to users.
- Skip pure dependency bumps unless notable. Skip CI/lint-only changes unless they affect users.
- Imperative present tense ("Add X", not "Added X").
- No PR/commit references in the bullets — those are linked separately.
- No preamble, no closing remarks. Just the sections.

Tag being released: ${tag}

Commits since previous tag:
${commits}`;

  try {
    const client = new AnthropicBedrock({
      awsRegion: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? DEFAULT_AWS_REGION,
    });
    const response = await client.messages.create({
      model: process.env.BEDROCK_MODEL_ID ?? DEFAULT_BEDROCK_MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('')
      .trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    console.error('bedrock call failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

function compareUrl(prev: string | null, tag: string): string | null {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return null;
  if (!prev) return `https://github.com/${repo}/releases/tag/${tag}`;
  return `https://github.com/${repo}/compare/${prev}...${tag}`;
}

async function main(): Promise<void> {
  const tag = currentTag();
  const prev = previousTag(tag);
  const commits = commitsBetween(prev, tag);

  let body: string;
  const ai = await summariseWithClaude(commits, tag);
  if (ai) {
    body = ai;
  } else {
    body = commits.length > 0 ? `### Changes\n\n${commits}` : '_No changes recorded._';
  }

  const compare = compareUrl(prev, tag);
  if (compare) body += `\n\n**Full changelog:** ${compare}`;

  process.stdout.write(body + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
