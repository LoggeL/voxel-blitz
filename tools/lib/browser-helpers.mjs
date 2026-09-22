import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Click an element's centre through CDP input, like a real pointer would. */
export async function clickById(page, id, { requireEnabled = false } = {}) {
  const point = await page.evaluate(`(() => {
    const element = document.getElementById(${JSON.stringify(id)});
    element?.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = element?.getBoundingClientRect();
    if (!rect?.width || !rect?.height) return null;
    if (${requireEnabled} && element.disabled) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point, requireEnabled ? `${id} is visible and enabled` : `visible #${id}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type, ...point, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
}

/** Write a viewport PNG of the page into dir. */
export async function screenshotTo(page, dir, name) {
  const capture = await page.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false,
  }, 15_000);
  await writeFile(path.join(dir, name), Buffer.from(capture.data, 'base64'));
}
