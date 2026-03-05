import { bold, green, red } from "@std/fmt/colors";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL = 80;

const encoder = new TextEncoder();
const write = (s: string) => Deno.stdout.writeSync(encoder.encode(s));

export class Spinner {
  #text: string;
  #timer?: ReturnType<typeof setInterval>;
  #frame = 0;

  constructor(text: string) {
    this.#text = text;
  }

  start() {
    write("\x1B[?25l"); // hide cursor
    this.#timer = setInterval(() => {
      this.#frame = (this.#frame + 1) % FRAMES.length;
      this.#render();
    }, INTERVAL);
    return this;
  }

  succeed(text?: string) {
    this.#stop();
    write(`${bold(green("✔"))} ${text ?? this.#text}\n`);
  }

  fail(text?: string) {
    this.#stop();
    write(`${bold(red("✖"))} ${text ?? this.#text}\n`);
  }

  #render() {
    write(`\r\x1B[2K${FRAMES[this.#frame]} ${this.#text}`);
  }

  #stop() {
    if (this.#timer) clearInterval(this.#timer);
    write("\r\x1B[2K\x1B[?25h"); // clear line + show cursor
  }
}
