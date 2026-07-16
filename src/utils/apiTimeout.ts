/**
 * Utility for handling API timeouts and retries with Promise.race
 */

/**
 * Wraps a promise with a timeout
 * @param promise - The promise to wrap
 * @param ms - Timeout in milliseconds
 * @param timeoutMessage - Custom message for timeout error
 * @returns Promise that rejects if timeout is exceeded
 */
export function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    timeoutMessage: string = 'API request timeout'
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    });
    return Promise.race([
        promise,
        timeoutPromise
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/**
 * Retries a function with exponential backoff
 * @param fn - Function to retry
 * @param retries - Number of retries
 * @param delay - Initial delay in ms
 * @returns Promise with result or throws error after all retries
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    retries: number = 2,
    delay: number = 500
): Promise<T> {
    let lastError: any;

    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // If this was the last attempt, throw the error
            if (i === retries) {
                throw lastError;
            }

            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
        }
    }

    throw lastError;
}

/**
 * Combines timeout and retry functionality
 * @param fn - Function to execute
 * @param timeoutMs - Timeout in milliseconds
 * @param retries - Number of retries
 * @param retryDelay - Initial delay between retries
 * @returns Promise with result or throws error
 */
export async function withTimeoutAndRetry<T>(
    fn: () => Promise<T>,
    timeoutMs: number = 8000,
    retries: number = 2,
    retryDelay: number = 500
): Promise<T> {
    return withRetry(
        () => withTimeout(fn(), timeoutMs, `API request timed out after ${timeoutMs}ms`),
        retries,
        retryDelay
    );
}