/**
 * Simple router for Cloudflare Workers
 */

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, path, ...handlers) {
    // Convert path to regex
    const pattern = path
      .replace(/\*/g, '.*')
      .replace(/:([^/]+)/g, '(?<$1>[^/]+)');
    
    this.routes.push({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${pattern}$`),
      handlers
    });
  }

  get(path, ...handlers) { this.add('GET', path, ...handlers); }
  post(path, ...handlers) { this.add('POST', path, ...handlers); }
  put(path, ...handlers) { this.add('PUT', path, ...handlers); }
  delete(path, ...handlers) { this.add('DELETE', path, ...handlers); }
  options(path, ...handlers) { this.add('OPTIONS', path, ...handlers); }
  all(path, ...handlers) { this.add('ALL', path, ...handlers); }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    for (const route of this.routes) {
      // HEAD is served by the matching GET route (the runtime drops the body).
      // Without this, HEAD on any API path fell through to the catch-all 404.
      const methodMatches = route.method === 'ALL'
        || route.method === method
        || (method === 'HEAD' && route.method === 'GET');
      if (!methodMatches) continue;


      const match = url.pathname.match(route.pattern);
      if (!match) continue;

      // Extract params from named groups
      const params = match.groups || {};
      
      // Create context object
      const context = {
        request,
        env,
        ctx,
        params,
        url,
        user: null
      };

      // Run handlers in sequence (middleware pattern)
      for (const handler of route.handlers) {
        const result = await handler(context);
        if (result instanceof Response) {
          // Middleware may register a response decorator (e.g. sliding
          // session renewal appending a fresh Set-Cookie header).
          return typeof context.decorateResponse === 'function'
            ? context.decorateResponse(result)
            : result;
        }
        // If handler returns nothing, continue to next
      }
    }

    // No route matched
    return new Response('Not Found', { status: 404 });
  }
}
