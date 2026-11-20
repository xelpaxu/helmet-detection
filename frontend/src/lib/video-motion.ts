const WIDTH = 256;
const HEIGHT = 144;
const SEARCH_RADIUS = 10;
const MAX_SHIFT = 16;

export type MotionFrame = { pixels: Uint8Array; time: number };
export type Position = { x: number; y: number };
type Region = Position & { w: number; h: number };

export function createMotionSampler() {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  return (source: CanvasImageSource, time: number): MotionFrame => {
    context.drawImage(source, 0, 0, WIDTH, HEIGHT);
    const rgba = context.getImageData(0, 0, WIDTH, HEIGHT).data;
    const pixels = new Uint8Array(WIDTH * HEIGHT);
    for (let i = 0, j = 0; i < pixels.length; i++, j += 4) {
      pixels[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    }
    return { pixels, time };
  };
}

export function matchMotion(previous: MotionFrame, current: MotionFrame, region: Region, expected: Position): Position | undefined {
  const expectedX = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, Math.round(expected.x * WIDTH)));
  const expectedY = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, Math.round(expected.y * HEIGHT)));
  const minX = Math.max(-MAX_SHIFT, expectedX - SEARCH_RADIUS), maxX = Math.min(MAX_SHIFT, expectedX + SEARCH_RADIUS);
  const minY = Math.max(-MAX_SHIFT, expectedY - SEARCH_RADIUS), maxY = Math.min(MAX_SHIFT, expectedY + SEARCH_RADIUS);
  const points = [];
  let minimum = 255, maximum = 0;
  for (let row = 1; row <= 5; row++) {
    for (let column = 1; column <= 5; column++) {
      const x = Math.round((region.x + region.w * column / 6) * WIDTH);
      const y = Math.round((region.y + region.h * row / 6) * HEIGHT);
      if (x + minX < 0 || y + minY < 0 || x + maxX >= WIDTH || y + maxY >= HEIGHT) continue;
      const index = y * WIDTH + x;
      const value = previous.pixels[index];
      points.push({ index, value });
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  if (points.length < 12 || region.w * WIDTH < 5 || region.h * HEIGHT < 5 || maximum - minimum < 28) return;

  let bestScore = Infinity, bestError = Infinity, x = 0, y = 0;
  for (let dy = minY; dy <= maxY; dy++) {
    for (let dx = minX; dx <= maxX; dx++) {
      let error = 0;
      const offset = dy * WIDTH + dx;
      for (const point of points) error += Math.abs(current.pixels[point.index + offset] - point.value);
      error /= points.length;
      const score = error + 0.25 * (Math.abs(dx - expectedX) + Math.abs(dy - expectedY));
      if (score < bestScore) {
        bestScore = score;
        bestError = error;
        x = dx;
        y = dy;
      }
    }
  }
  if (bestError > 25) return;
  return { x: x / WIDTH, y: y / HEIGHT };
}
