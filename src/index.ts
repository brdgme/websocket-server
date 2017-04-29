import * as WebSocket from 'ws';
import * as Redis from 'redis';
import * as Log from 'loglevel';
import * as Http from 'http';

/**
 * Configuration environment variables and defaults.
 */
const PORT = parseInt(process.env.WS_PORT || 8081);
const REDIS_URL = process.env.WS_REDIS_URL;
const LOG_LEVEL = process.env.WS_LOG_LEVEL;
if (LOG_LEVEL !== undefined) {
  Log.setLevel(LOG_LEVEL);
}

/**
 * Connect to Redis, do this first as if we can't connect there's no point
 * continuing.
 */
let redis: Redis.RedisClient;
if (REDIS_URL) {
  redis = Redis.createClient(REDIS_URL);
} else {
  redis = Redis.createClient(); 
}

/**
 * `hasPrefix` checks whether the prefix `p` is present in the string `str`.
 * @param {string} p Prefix
 * @param {string} str String to check
 */
function hasPrefix(p: string, str: string): boolean {
  return str.substr(0, p.length) === p;
}

/**
 * `wsSub` extracts the subscription name from the WebSocket request URL.
 * @param {WebSocket} ws
 */
function wsSub(ws: WebSocket): string {
  return (ws.upgradeReq.url || '/').substr(1);
}

/**
 * `allowedPrefixes` is the predefined list of which URL prefixes are allowed.
 * @var {array<string>}
 */
const allowedPrefixes = [
  'user.',
  'game.',
];

/**
 * `Subscriptions` tracks all WebSocket connections against their subscription
 * names.
 */
class Subscriptions {
  subs: {
    [sub: string]: WebSocket[],
  };

  constructor() {
    this.subs = {};
    this.handleMessage = this.handleMessage.bind(this);
  }

  /**
   * `subscribe` takes a `WebSocket` object, extracts a subscription name, and
   * subscribes to Redis if it's not already subscribed.
   * @param {WebSocket} ws 
   */
  subscribe(ws: WebSocket) {
    const sub = wsSub(ws);
    if (this.subs[sub] === undefined) {
      this.subs[sub] = [];
      if (!redis.subscribe(sub)) {
        throw(`failed to subscribe: ${sub}`);
      }
    }
    this.subs[sub].push(ws);
    Log.info(`Subscribed ${sub}`);
  }

  /**
   * `subscribe` takes a `WebSocket` object, extracts a subscription name, and
   * unsubscribes from Redis if it's the last subscription by this name.
   * @param {WebSocket} ws 
   */
  unsubscribe(ws: WebSocket) {
    const sub = wsSub(ws);
    if (this.subs[sub] === undefined) {
      return;
    }
    const index = this.subs[sub].indexOf(ws);
    if (index === -1) {
      return;
    }
    this.subs[sub].splice(index, 1);
    if (this.subs[sub].length === 0) {
      delete this.subs[sub];
      if (!redis.unsubscribe(sub)) {
        throw(`failed to unsubscribe: ${sub}`);
      }
    }
    Log.info(`Unsubscribed ${sub}`);
  }

  /**
   * `handleMessage` is a `Redis` 'message' handler, proxying messages to
   * subscriptions.
   * @param {string} channel 
   * @param {string} message 
   */
  handleMessage(channel: string, message: string) {
    if (this.subs[channel] === undefined) {
      Log.debug(`Got message for channel ${channel}, but no subscribers`);
      return;
    }
    Log.debug(`Sending message to ${this.subs[channel].length} subscribers on '${channel}': ${message}`);
    for (const ws of this.subs[channel]) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }
}
/**
 * Create our global subscription object and register it with Redis.
 */
let subscriptions = new Subscriptions();
redis.on('message', subscriptions.handleMessage);

/**
 * Listen for WebSocket connections. We use a custom connection to reply 200 by
 * default so Elastic Beanstalk can assume it's healthy.
 */
let server = Http.createServer((req, res) => {
  const body = '';
  res.writeHead(200, {
    'Content-Length': body.length,
    'Content-Type': 'text/plain',
  });
  res.end(body);
});
server.listen(PORT);
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  const subReq = wsSub(ws);
  // Wildcards are unsupported.
  if (subReq.indexOf('*') !== -1) {
    ws.terminate();
    return;
  }
  // Only certain prefixes are allowed.
  let allowed = false;
  for (const p of allowedPrefixes) {
    if (hasPrefix(p, subReq)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    ws.terminate();
    return;
  }
  ws.on('close', () => {
    subscriptions.unsubscribe(ws);
  });
  subscriptions.subscribe(ws);
});