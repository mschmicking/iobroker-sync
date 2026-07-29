/**
 * Terminal prompts for interactive `init` and for asking about a missing password.
 *
 * Everything here is strictly opt-in: nothing prompts unless stdin *and* stdout are
 * a TTY. A CLI that blocks waiting for input when run from a script, a CI job or an
 * agent is worse than one that fails with a clear message, so callers must check
 * `isInteractive()` and fall back to a `UserError` when it is false.
 */

import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';

export function isInteractive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/** Asks a question, returning the trimmed answer, or `fallback` when the user just hits enter. */
export function promptText(question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed.length > 0 ? trimmed : (fallback ?? ''));
    });
  });
}

/** Asks a yes/no question. */
export async function promptYesNo(question: string, fallback: boolean): Promise<boolean> {
  const answer = await promptText(`${question} (y/n)`, fallback ? 'y' : 'n');
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * Asks for a secret without echoing it.
 *
 * readline redraws the whole input line on every keystroke via `_writeToOutput`;
 * replacing it with a no-op while the answer is being typed is what keeps the
 * password off the screen — and, more importantly, out of anything scrolled back to
 * or captured from the terminal.
 */
export function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });

    let muted = false;
    const mutable = rl as unknown as { _writeToOutput: (text: string) => void };
    const original = mutable._writeToOutput.bind(rl);
    mutable._writeToOutput = (text: string): void => {
      if (!muted) {
        original(text);
        return;
      }
      // Let the newline through so the cursor still moves on submit.
      if (text.includes('\n')) stdout.write('\n');
    };

    rl.question(`${question}: `, (answer) => {
      mutable._writeToOutput = original;
      rl.close();
      resolve(answer);
    });

    // Set after `question` so the prompt itself is printed.
    muted = true;
  });
}

/**
 * Reads a password from stdin, for `--password-stdin`.
 *
 * This is the way to supply a password non-interactively without putting it in argv
 * (visible in `ps`) or in the environment of unrelated child processes.
 */
export async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  // Only the trailing newline from `echo` is stripped; a password may contain spaces.
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
