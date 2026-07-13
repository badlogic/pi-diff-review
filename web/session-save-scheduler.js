export function createSessionSaveScheduler(save, delay, timers = globalThis) {
  let timer = null;

  const cancel = () => {
    if (timer == null) return false;
    timers.clearTimeout(timer);
    timer = null;
    return true;
  };

  return {
    schedule() {
      cancel();
      timer = timers.setTimeout(() => {
        timer = null;
        save();
      }, delay);
    },
    flush() {
      if (!cancel()) return;
      save();
    },
    cancel,
  };
}
