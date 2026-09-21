/**
 * Terminal prompts for the migration scripts.
 *
 * A hidden answer (password, key, connection string) is read character by
 * character in raw mode and never written back — so neither typing nor a paste
 * can put it on the screen. readline was used before and leaked a pasted key:
 * a paste makes it redraw the whole line, answer included.
 */
import readline from 'readline';

/** Ask for a line of visible text. */
export function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

/** Ask for a secret. Nothing typed or pasted is shown. */
export function askHidden(question) {
  const stdin = process.stdin;
  process.stdout.write(question);
  if (!stdin.isTTY) {
    // piped input: nothing is echoed anyway
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin });
      rl.once('line', (line) => { rl.close(); process.stdout.write('\n'); resolve(line.trim()); });
      rl.once('close', () => resolve(''));
    });
  }
  return new Promise((resolve) => {
    let answer = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      // a terminal may wrap a paste in bracketed-paste markers
      resolve(answer.replace(/\x1b\[[0-9;]*[~A-Za-z]/g, '').trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }   // Ctrl-C
        if (ch === '\u007f' || ch === '\b') answer = answer.slice(0, -1);
        else answer += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}
