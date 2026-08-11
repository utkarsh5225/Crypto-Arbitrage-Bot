import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

let rl: readline.Interface | null = null;

function iface(): readline.Interface {
  if (!rl) rl = readline.createInterface({ input: stdin, output: stdout });
  return rl;
}

export async function ask(question: string): Promise<string> {
  const answer = await iface().question(question);
  return answer.trim();
}

export function closePrompt(): void {
  rl?.close();
  rl = null;
}
