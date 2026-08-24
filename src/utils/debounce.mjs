/**
 * @param {number} [delay]
 * @returns {(key: string, fn: () => void) => void}
 */
export function createDebouncer(delay = 150) {
    const timers = new Map();
    return (key, fn) => {
        const existing = timers.get(key);
        if (existing) clearTimeout(existing);
        timers.set(
            key,
            setTimeout(() => {
                timers.delete(key);
                fn();
            }, delay),
        );
    };
}

const timers = new Map();

/**
 *
 * @param {string|symbol|number} key
 * @param {number} delay
 * @param {()=>any} fn
 */
export function debounce(delay,key, fn) {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
        key,
        setTimeout(() => {
            timers.delete(key);
            fn();
        }, delay),
    );
}
