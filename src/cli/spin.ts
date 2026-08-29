// Wait feedback (Deck CLI Identity §5): one dim braille spinner line on
// stderr, only past 120 ms of pending TTY work; erased with \r + ESC[2K
// before real output. Non-TTY is totally silent; TERM=dumb gets a single
// static line past 2 s. NO_COLOR does not disable it — it is not color.

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const SPIN_DELAY_MS = 120;
const FRAME_MS = 80;
const DUMB_DELAY_MS = 2000;

export interface SpinHandle {
  done(): void;
}

export interface SpinIo {
  err(text: string): void;
}

export function withSpinner<T>(
  opts: { isatty: boolean; dumb: boolean; io: SpinIo },
  verb: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!opts.isatty) return fn(); // non-TTY: total silence

  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  const erase = () => {
    opts.io.err('\r\x1b[2K');
  };

  if (opts.dumb) {
    timer = setTimeout(() => {
      timer = undefined;
      opts.io.err(`deck: ${verb}...`);
    }, DUMB_DELAY_MS);
  } else {
    timer = setTimeout(() => {
      timer = undefined;
      opts.io.err(`${FRAMES[0]} ${verb}…`);
      interval = setInterval(() => {
        frame = (frame + 1) % FRAMES.length;
        erase();
        opts.io.err(`${FRAMES[frame]} ${verb}…`);
      }, FRAME_MS);
    }, SPIN_DELAY_MS);
  }

  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (interval !== undefined) clearInterval(interval);
    if (timer === undefined || interval !== undefined) erase();
  };

  return fn().then(
    (value) => {
      stop();
      return value;
    },
    (error) => {
      stop();
      throw error;
    },
  );
}
