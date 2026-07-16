"use strict";
/**
 * Utility for handling API timeouts and retries with Promise.race
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.withTimeout = withTimeout;
exports.withRetry = withRetry;
exports.withTimeoutAndRetry = withTimeoutAndRetry;
/**
 * Wraps a promise with a timeout
 * @param promise - The promise to wrap
 * @param ms - Timeout in milliseconds
 * @param timeoutMessage - Custom message for timeout error
 * @returns Promise that rejects if timeout is exceeded
 */
function withTimeout(promise, ms, timeoutMessage = 'API request timeout') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    });
    return Promise.race([
        promise,
        timeoutPromise
    ]).finally(() => {
        if (timer)
            clearTimeout(timer);
    });
}
/**
 * Retries a function with exponential backoff
 * @param fn - Function to retry
 * @param retries - Number of retries
 * @param delay - Initial delay in ms
 * @returns Promise with result or throws error after all retries
 */
async function withRetry(fn, retries = 2, delay = 500) {
    let lastError;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        }
        catch (error) {
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
async function withTimeoutAndRetry(fn, timeoutMs = 8000, retries = 2, retryDelay = 500) {
    return withRetry(() => withTimeout(fn(), timeoutMs, `API request timed out after ${timeoutMs}ms`), retries, retryDelay);
}
