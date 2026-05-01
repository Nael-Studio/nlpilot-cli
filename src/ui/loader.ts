import { stdout } from "node:process";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL = 80; // ms per frame

interface LoaderState {
  frameIndex: number;
  intervalId: NodeJS.Timeout | null;
  message: string;
}

const loaderState: LoaderState = {
  frameIndex: 0,
  intervalId: null,
  message: "",
};

/**
 * Start a loading spinner with an optional message.
 * @param message The message to display next to the spinner
 */
export function startLoader(message: string = ""): void {
  if (loaderState.intervalId) {
    stopLoader();
  }

  loaderState.message = message;
  loaderState.frameIndex = 0;

  loaderState.intervalId = setInterval(() => {
    const frame = FRAMES[loaderState.frameIndex];
    const display = loaderState.message
      ? `${frame} ${loaderState.message}`
      : frame;

    stdout.write(`\r${display}`);
    loaderState.frameIndex = (loaderState.frameIndex + 1) % FRAMES.length;
  }, INTERVAL);
}

/**
 * Stop the loading spinner and clear the line.
 */
export function stopLoader(): void {
  if (loaderState.intervalId) {
    clearInterval(loaderState.intervalId);
    loaderState.intervalId = null;
  }

  // Clear the line
  stdout.write("\r\x1b[K");
}

/**
 * Stop the loader and print a message.
 * @param message The message to print (e.g., "✓ Done")
 */
export function stopLoaderWithMessage(message: string): void {
  if (loaderState.intervalId) {
    clearInterval(loaderState.intervalId);
    loaderState.intervalId = null;
  }

  stdout.write(`\r${message}\n`);
}
