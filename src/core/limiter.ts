export function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const run = async function run<T>(job: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await job();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
  return Object.assign(run, { active: () => active, queued: () => waiting.length, max });
}
