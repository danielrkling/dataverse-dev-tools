export function createDebouncer(delay = 150) {
  const timers = new Map();
  return (key, fn) => {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      fn();
    }, delay));
  };
}
