import { chromium } from 'playwright';

export function launchBrowser() {
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
  return chromium.launch({
    timeout: 10_000,
    ...(executablePath ? { executablePath, args: ['--disable-gpu'] } : {}),
  });
}
