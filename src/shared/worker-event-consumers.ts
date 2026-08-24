/**
 * Durable event consumer ids.
 *
 * The worker keeps one cursor and one unacknowledged window per consumer id, so
 * the stream a client attaches and the subscribe/ack calls it makes must agree on
 * the same value. These live in a leaf module because both the transport and the
 * subscribing code need them, and importing one from the other would either
 * invert the process layering or drag a whole module into contexts that only
 * wanted the constant.
 */

/** The Electron host: background runs, cron, and journal replay. */
export const DESKTOP_EVENT_CONSUMER_ID = 'desktop'
