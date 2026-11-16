export function createCoalescedRefresh() {
  let pending = false;
  let running: Promise<void> | null = null;

  return async function run(task: () => Promise<void>): Promise<void> {
    if (running) {
      pending = true;
      await running;
      return;
    }

    const drain = async () => {
      do {
        pending = false;
        await task();
      } while (pending);
    };

    const current = Promise.resolve().then(drain);
    running = current.finally(() => { running = null; });
    await running;
  };
}
