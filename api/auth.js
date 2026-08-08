/**
 * OAuth Authentication Handler
 * Supports Google and Microsoft SSO
 * Domain: ride.incitat.io
 */

import { jsonResponse, errorResponse, generateId, createSession, setSessionCookie, clearSessionCookie, getSessionToken, readCookie, BASE_URL } from './utils.js';
import { readJsonBody } from './handler-utils.js';

const ADMIN_PAGE_SIZES = [25, 50, 100, 250];
const ADMIN_DEFAULT_PAGE_SIZE = 50;
const ADMIN_MAX_SEARCH_LENGTH = 120;

/** Only a bare column reference (optionally table-qualified) may reach ORDER BY. */
const SORT_EXPR_PATTERN = /^[a-z_]+(\.[a-z_]+)?$/;

function getAdminListOptions(url, sortColumns, defaultSort = 'created_at') {
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') || String(ADMIN_DEFAULT_PAGE_SIZE), 10);
  const limit = ADMIN_PAGE_SIZES.includes(requestedLimit) ? requestedLimit : ADMIN_DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const q = (url.searchParams.get('q') || '').trim().slice(0, ADMIN_MAX_SEARCH_LENGTH);
  const requestedSort = url.searchParams.get('sort') || defaultSort;
  // hasOwnProperty, not a bare lookup: `?sort=constructor` / `?sort=__proto__`
  // otherwise resolved through the prototype chain into the ORDER BY clause.
  const sort = Object.prototype.hasOwnProperty.call(sortColumns, requestedSort) ? requestedSort : defaultSort;
  const sortExpr = sortColumns[sort];
  return {
    limit,
    page,
    offset: (page - 1) * limit,
    q,
    sort,
    // Belt and braces: sortExpr is the one value interpolated into SQL as text.
    sortExpr: SORT_EXPR_PATTERN.test(sortExpr || '') ? sortExpr : sortColumns[defaultSort],
    dir: (url.searchParams.get('dir') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  };
}

/**
 * Short-lived cookie that binds an OAuth flow to the browser that started it.
 * Without it, an attacker could hand a victim a valid state+code pair and have
 * the victim's browser sign in to the *attacker's* account (login CSRF).
 * __Host- prefix: requires Secure + Path=/ + no Domain, so no sibling
 * subdomain can plant or overwrite it.
 */
const OAUTH_STATE_COOKIE = '__Host-ride_oauth_state';
const OAUTH_STATE_TTL_SECONDS = 300;

function setStateCookie(state) {
  return `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_STATE_TTL_SECONDS}`;
}

function expireStateCookie() {
  return `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * Redirect back into the app. Response.redirect() requires an absolute URL and
 * throws a TypeError on a relative one — every OAuth failure path used to hand
 * the user a raw 500 JSON blob because of that (including "user clicked Cancel").
 */
function redirectToApp(path) {
  const target = /^https?:\/\//i.test(path) ? path : `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers({ Location: target, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', expireStateCookie());
  return new Response(null, { status: 302, headers });
}

function paginationResponse(total, options) {
  return {
    page: options.page,
    limit: options.limit,
    total,
    totalPages: Math.max(1, Math.ceil((total || 0) / options.limit)),
  };
}

function likeTerm(q) {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

function normalizeAdminStatus(status) {
  if (status === 'suspended') return 'paused';
  if (status === 'banned') return 'blocked';
  if (status === 'paused' || status === 'blocked' || status === 'active') return status;
  return 'active';
}

function isAllowedAdminStatus(status) {
  return ['active', 'paused', 'blocked', 'suspended', 'banned'].includes(status);
}

// OAuth provider configurations
const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: ['openid', 'email', 'profile'],
    getClientId: (env) => env.GOOGLE_CLIENT_ID,
    getClientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    parseUser: (data) => ({
      email: data.email,
      name: data.name,
      avatar_url: data.picture,
      provider_id: data.id,
      // Google explicitly vouches for the address. Both the v2 userinfo field
      // and the OIDC claim are accepted; anything other than a literal true is
      // treated as unverified.
      emailVerified: data.verified_email === true || data.email_verified === true
    })
  },

  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userUrl: 'https://graph.microsoft.com/v1.0/me',
    scopes: ['openid', 'email', 'profile', 'User.Read'],
    getClientId: (env) => env.MICROSOFT_CLIENT_ID,
    getClientSecret: (env) => env.MICROSOFT_CLIENT_SECRET,
    parseUser: (data) => ({
      email: data.mail || data.userPrincipalName,
      name: data.displayName,
      avatar_url: null, // MS Graph requires separate call for photo
      provider_id: data.id,
      // NEVER true. We authenticate against the multi-tenant /common endpoint,
      // where `mail` is an arbitrary tenant-controlled directory attribute and
      // is not proof of address ownership (the nOAuth account-takeover class).
      // The address is display-only; identity is keyed strictly on the
      // immutable provider subject (`id`).
      emailVerified: false
    })
  }
};

export const AuthHandler = {
  /**
   * Initiate OAuth login - redirect to provider
   */
  async initiateLogin(context) {
    const { params, env, url } = context;
    const providerName = params.provider;
    
    const provider = PROVIDERS[providerName];
    if (!provider) {
      return errorResponse('Invalid provider', 400);
    }
    
    const clientId = provider.getClientId(env);
    if (!clientId) {
      return errorResponse('Provider not configured', 500);
    }
    
    // Generate state for CSRF protection
    const state = crypto.randomUUID();
    
    // Store state in KV temporarily (5 minutes)
    // Validate return URL — extract path from same-origin URLs, reject foreign origins
    let returnUrl = url.searchParams.get('return') || '/';
    try {
      const parsed = new URL(returnUrl, BASE_URL);
      // Only allow same-origin return URLs
      if (parsed.origin === new URL(BASE_URL).origin) {
        returnUrl = parsed.pathname + parsed.search + parsed.hash;
      } else {
        returnUrl = '/';
      }
    } catch {
      // If URL parsing fails, ensure it's a safe relative path
      if (!returnUrl.startsWith('/') || returnUrl.startsWith('//')) {
        returnUrl = '/';
      }
    }
    await env.RIDE_TRIP_PLANNER_SESSIONS.put(`oauth_state_${state}`, JSON.stringify({
      provider: providerName,
      returnUrl
    }), { expirationTtl: OAUTH_STATE_TTL_SECONDS });
    
    // Build redirect URL - use BASE_URL in production for consistency
    const origin = env.ENVIRONMENT === 'production' ? BASE_URL : url.origin;
    const redirectUri = `${origin}/api/auth/callback/${providerName}`;
    
    const authParams = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: provider.scopes.join(' '),
      state: state
    });
    
    // Microsoft requires additional params
    if (providerName === 'microsoft') {
      authParams.set('response_mode', 'query');
    }
    
    const authUrl = `${provider.authUrl}?${authParams.toString()}`;

    // Bind the flow to this browser: the same nonce goes out as an HttpOnly
    // cookie and must come back on the callback.
    return new Response(null, {
      status: 302,
      headers: new Headers({
        Location: authUrl,
        'Cache-Control': 'no-store',
        'Set-Cookie': setStateCookie(state)
      })
    });
  },
  
  /**
   * Handle OAuth callback from provider
   */
  async handleCallback(context) {
    const { params, env, url, request } = context;
    const providerName = params.provider;
    
    const provider = PROVIDERS[providerName];
    if (!provider) {
      return errorResponse('Invalid provider', 400);
    }
    
    // Verify state
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    
    if (error) {
      console.error('OAuth error:', error, url.searchParams.get('error_description'));
      // Most common non-happy path there is: the user clicked Cancel.
      return redirectToApp('/?error=auth_failed');
    }

    if (!state || !code) {
      return redirectToApp('/?error=missing_state');
    }

    // The state must match the nonce this browser was issued at login start.
    // KV existence alone proves only that *some* browser started a flow.
    const stateCookie = readCookie(request, OAUTH_STATE_COOKIE);
    if (!stateCookie || stateCookie !== state) {
      console.error('OAuth state cookie mismatch');
      return redirectToApp('/?error=invalid_state');
    }

    // Verify state from KV
    const stateData = await env.RIDE_TRIP_PLANNER_SESSIONS.get(`oauth_state_${state}`, 'json');
    if (!stateData || stateData.provider !== providerName) {
      return redirectToApp('/?error=invalid_state');
    }
    await env.RIDE_TRIP_PLANNER_SESSIONS.delete(`oauth_state_${state}`);


    // Exchange code for token — use BASE_URL for consistent redirect_uri
    const origin = env.ENVIRONMENT === 'production' ? BASE_URL : url.origin;
    const redirectUri = `${origin}/api/auth/callback/${providerName}`;
    
    const tokenParams = new URLSearchParams({
      client_id: provider.getClientId(env),
      client_secret: provider.getClientSecret(env),
      code: code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });
    
    const tokenResponse = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: tokenParams.toString()
    });
    
    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', await tokenResponse.text());
      return redirectToApp('/?error=token_failed');
    }
    
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    
    // Fetch user info
    const userResponse = await fetch(provider.userUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });
    
    if (!userResponse.ok) {
      console.error('User info fetch failed:', await userResponse.text());
      return redirectToApp('/?error=user_fetch_failed');
    }

    const userData = await userResponse.json();
    const parsedUser = provider.parseUser(userData);
    if (!parsedUser?.email) {
      console.error('OAuth user missing email', providerName);
      return redirectToApp('/?error=no_email');
    }
    if (!parsedUser.provider_id) {
      console.error('OAuth user missing provider subject', providerName);
      return redirectToApp('/?error=user_fetch_failed');
    }
    const normalizedEmail = parsedUser.email.toLowerCase();

    // Create or update user in D1
    let user;
    try {
      user = await createOrUpdateUser(env.RIDE_TRIP_PLANNER_DB, {
        ...parsedUser,
        email: normalizedEmail,
        provider: providerName
      });
    } catch (err) {
      if (err?.code === 'UNVERIFIED_EMAIL_LINK') {
        // An account already exists for this address and the provider did not
        // prove the signer owns it. Refuse rather than silently merge.
        console.error('Refused unverified OAuth account link', providerName);
        return redirectToApp('/?error=email_not_verified');
      }
      throw err;
    }


    // Create session
    const session = await createSession(env, {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url
    });

    // Lightweight audit log — use waitUntil so it finishes even after response
    context.ctx.waitUntil(
      recordLogin(env, user, providerName, request).catch((err) => {
        console.error('login audit failed', err);
      })
    );
    
    // Redirect to app with session cookie. redirectToApp also expires the
    // one-shot OAuth state cookie so it can never be replayed.
    const response = redirectToApp(stateData.returnUrl || '/');

    return setSessionCookie(response, session.token, session.expiresAt);
  },
  
  /**
   * Get current logged-in user
   */
  async getCurrentUser(context) {
    return jsonResponse({ user: context.user });
  },
  
  /**
   * Logout - clear session
   */
  async logout(context) {
    const { request, env } = context;

    // Shared reader: handles the __Host- cookie, the legacy name, and Bearer
    // tokens, and is anchored so `x_ride_session` can never be picked up.
    const token = getSessionToken(request);

    if (token) {
      // Read session to get user ID for registry cleanup
      try {
        const sessionData = await env.RIDE_TRIP_PLANNER_SESSIONS.get(token, 'json');
        if (sessionData?.user?.id) {
          const registryKey = `sessions:${sessionData.user.id}`;
          const raw = await env.RIDE_TRIP_PLANNER_SESSIONS.get(registryKey, 'json');
          if (Array.isArray(raw)) {
            const filtered = raw.filter(s => s.token !== token);
            if (filtered.length > 0) {
              await env.RIDE_TRIP_PLANNER_SESSIONS.put(registryKey, JSON.stringify(filtered), {
                expirationTtl: 30 * 24 * 60 * 60
              });
            } else {
              await env.RIDE_TRIP_PLANNER_SESSIONS.delete(registryKey);
            }
          }
        }
      } catch (_) { /* non-critical */ }

      // Delete session from KV
      await env.RIDE_TRIP_PLANNER_SESSIONS.delete(token);
    }
    
    const response = jsonResponse({ success: true });
    return clearSessionCookie(response);
  },

  /**
   * Admin: dashboard stats
   */
  async adminStats(context) {
    const { env } = context;
    const db = env.RIDE_TRIP_PLANNER_DB;

    // Run all stat queries in parallel
    const [users, trips, waypoints, journals, attachments, providers, signups7d, signups30d, logins7d, logins30d, loginsByDay] = await Promise.all([
      db.prepare('SELECT COUNT(*) AS c FROM users').first(),
      db.prepare('SELECT COUNT(*) AS c FROM trips').first(),
      db.prepare('SELECT COUNT(*) AS c FROM waypoints').first(),
      db.prepare('SELECT COUNT(*) AS c FROM journal_entries').first(),
      db.prepare('SELECT COALESCE(COUNT(*),0) AS c, COALESCE(SUM(size_bytes),0) AS bytes FROM attachments').first(),
      db.prepare("SELECT provider, COUNT(*) AS c FROM users GROUP BY provider ORDER BY c DESC").all(),
      db.prepare("SELECT COUNT(*) AS c FROM users WHERE created_at >= datetime('now','-7 days')").first(),
      db.prepare("SELECT COUNT(*) AS c FROM users WHERE created_at >= datetime('now','-30 days')").first(),
      db.prepare("SELECT COUNT(*) AS c FROM login_events WHERE created_at >= datetime('now','-7 days')").first(),
      db.prepare("SELECT COUNT(*) AS c FROM login_events WHERE created_at >= datetime('now','-30 days')").first(),
      db.prepare("SELECT date(created_at) AS day, COUNT(*) AS c FROM login_events WHERE created_at >= datetime('now','-30 days') GROUP BY day ORDER BY day").all(),
    ]);

    return jsonResponse({
      users: users.c,
      trips: trips.c,
      waypoints: waypoints.c,
      journals: journals.c,
      attachments: attachments.c,
      storageBytes: attachments.bytes,
      providers: (providers.results || []).map(r => ({ provider: r.provider, count: r.c })),
      signups7d: signups7d.c,
      signups30d: signups30d.c,
      logins7d: logins7d.c,
      logins30d: logins30d.c,
      loginsByDay: (loginsByDay.results || []).map(r => ({ day: r.day, count: r.c })),
    });
  },

  /**
   * Admin: list users with trip counts
   */
  async listUsersAdmin(context) {
    const { env, url } = context;
    const options = getAdminListOptions(url, {
      name: 'u.name',
      email: 'u.email',
      provider: 'u.provider',
      status: 'u.status',
      trip_count: 'trip_count',
      created_at: 'u.created_at',
      last_login: 'u.last_login',
    });

    const filters = [];
    const values = [];
    if (options.q) {
      filters.push('(u.email LIKE ? ESCAPE \'\\\' OR u.name LIKE ? ESCAPE \'\\\' OR u.provider LIKE ? ESCAPE \'\\\')');
      const term = likeTerm(options.q);
      values.push(term, term, term);
    }
    const status = url.searchParams.get('status');
    if (status && status !== 'all') {
      if (status === 'paused') {
        filters.push("COALESCE(u.status, 'active') IN ('paused', 'suspended')");
      } else if (status === 'blocked') {
        filters.push("COALESCE(u.status, 'active') IN ('blocked', 'banned')");
      } else {
        filters.push('COALESCE(u.status, \'active\') = ?');
        values.push(status);
      }
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const count = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT COUNT(*) AS c FROM users u ${where}`
    ).bind(...values).first();

    const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT u.id, u.email, u.name, u.avatar_url, u.provider, u.provider_id,
              COALESCE(u.status, 'active') AS status, u.created_at, u.updated_at, u.last_login,
              (SELECT COUNT(*) FROM trips t WHERE t.user_id = u.id) AS trip_count,
              (SELECT COUNT(*) FROM auth_identities ai WHERE ai.user_id = u.id) AS identity_count,
              (SELECT COUNT(*) FROM admin_notes an WHERE an.user_id = u.id) AS note_count,
              (SELECT MAX(an.created_at) FROM admin_notes an WHERE an.user_id = u.id) AS last_admin_note_at
       FROM users u
       ${where}
       ORDER BY ${options.sortExpr} ${options.dir}, u.id ASC
       LIMIT ? OFFSET ?`
    ).bind(...values, options.limit, options.offset).all();

    return jsonResponse({ users: result.results || [], pagination: paginationResponse(count?.c || 0, options) });
  },

  /**
   * Admin: recent login events
   */
  async listLoginsAdmin(context) {
    const { env, url } = context;
    const options = getAdminListOptions(url, {
      created_at: 'created_at',
      email: 'email',
      provider: 'provider',
      ip: 'ip',
      user_agent: 'user_agent',
    });

    const filters = [];
    const values = [];
    if (options.q) {
      filters.push('(email LIKE ? ESCAPE \'\\\' OR ip LIKE ? ESCAPE \'\\\' OR provider LIKE ? ESCAPE \'\\\' OR user_agent LIKE ? ESCAPE \'\\\' OR client_hints LIKE ? ESCAPE \'\\\')');
      const term = likeTerm(options.q);
      values.push(term, term, term, term, term);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const count = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT COUNT(*) AS c FROM login_events ${where}`
    ).bind(...values).first();

    const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT id, user_id, email, provider, ip, user_agent, client_hints, created_at
       FROM login_events
       ${where}
       ORDER BY ${options.sortExpr} ${options.dir}, id ASC
       LIMIT ? OFFSET ?`
    ).bind(...values, options.limit, options.offset).all();

    return jsonResponse({ events: result.results || [], pagination: paginationResponse(count?.c || 0, options) });
  },

  /**
   * Admin: share link view audit trail
   */
  async listShareViewsAdmin(context) {
    const { env, url } = context;
    const db = env.RIDE_TRIP_PLANNER_DB;
    const options = getAdminListOptions(url, {
      created_at: 'sv.created_at',
      trip_name: 't.name',
      short_code: 'sv.short_code',
      owner_name: 'u.name',
      viewer_label: 'sv.viewer_label',
      ip: 'sv.ip',
      referrer: 'sv.referrer',
    });

    const filters = [];
    const values = [];
    if (options.q) {
      filters.push('(sv.short_code LIKE ? ESCAPE \'\\\' OR sv.ip LIKE ? ESCAPE \'\\\' OR sv.viewer_label LIKE ? ESCAPE \'\\\' OR sv.referrer LIKE ? ESCAPE \'\\\' OR sv.client_hints LIKE ? ESCAPE \'\\\' OR t.name LIKE ? ESCAPE \'\\\' OR u.name LIKE ? ESCAPE \'\\\' OR u.email LIKE ? ESCAPE \'\\\')');
      const term = likeTerm(options.q);
      values.push(term, term, term, term, term, term, term, term);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const count = await db.prepare(
      `SELECT COUNT(*) AS c
       FROM share_views sv
       LEFT JOIN trips t ON t.id = sv.trip_id
       LEFT JOIN users u ON u.id = t.user_id
       ${where}`
    ).bind(...values).first();

    const result = await db.prepare(
      `SELECT sv.id, sv.trip_id, sv.short_code, sv.viewer_label, sv.ip,
              sv.user_agent, sv.client_hints, sv.referrer, sv.created_at,
              t.name AS trip_name, u.name AS owner_name, u.email AS owner_email
       FROM share_views sv
       LEFT JOIN trips t ON t.id = sv.trip_id
       LEFT JOIN users u ON u.id = t.user_id
       ${where}
       ORDER BY ${options.sortExpr} ${options.dir}, sv.id ASC
       LIMIT ? OFFSET ?`
    ).bind(...values, options.limit, options.offset).all();

    return jsonResponse({ views: result.results || [], pagination: paginationResponse(count?.c || 0, options) });
  },

  /**
   * Admin: full account audit snapshot
   * Returns user profile, all trips (with waypoints, journal, attachments),
   * admin notes, login history, and automated content flags.
   */
  async auditUser(context) {
    const { env, params } = context;
    const userId = params.id;
    const db = env.RIDE_TRIP_PLANNER_DB;

    // Fetch user
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    if (!user) return errorResponse('User not found', 404);

    // Parallel fetch everything
    const [trips, waypoints, journals, attachments, identities, logins, notes] = await Promise.all([
      db.prepare('SELECT id, name, description, public_title, public_description, public_contact, is_public, cover_image_url, created_at, updated_at FROM trips WHERE user_id = ?').bind(userId).all(),
      db.prepare('SELECT w.id, w.trip_id, w.name, w.address, w.notes FROM waypoints w JOIN trips t ON w.trip_id = t.id WHERE t.user_id = ?').bind(userId).all(),
      db.prepare('SELECT j.id, j.trip_id, j.title, j.content, j.tags, j.is_private, j.created_at FROM journal_entries j JOIN trips t ON j.trip_id = t.id WHERE t.user_id = ?').bind(userId).all(),
      db.prepare('SELECT a.id, a.trip_id, a.filename, a.original_name, a.mime_type, a.size_bytes, a.storage_key, a.is_cover, a.caption, a.created_at FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE t.user_id = ?').bind(userId).all(),
      db.prepare('SELECT id, provider, provider_id, email, created_at, last_login FROM auth_identities WHERE user_id = ?').bind(userId).all(),
      db.prepare('SELECT email, provider, ip, user_agent, client_hints, created_at FROM login_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(userId).all(),
      db.prepare('SELECT id, admin_email, action, content, created_at, updated_at FROM admin_notes WHERE user_id = ? ORDER BY COALESCE(updated_at, created_at) DESC').bind(userId).all(),
    ]);

    // Automated content scan
    const flags = scanContent({
      user,
      trips: trips.results || [],
      waypoints: waypoints.results || [],
      journals: journals.results || [],
      attachments: attachments.results || [],
    });

    // Build attachment URLs for image preview
    const images = (attachments.results || []).filter(a => a.mime_type && a.mime_type.startsWith('image/')).map(a => ({
      id: a.id,
      name: a.original_name,
      url: '/api/attachments/' + a.id,
      size: a.size_bytes,
      caption: a.caption,
      isCover: !!a.is_cover,
    }));

    return jsonResponse({
      user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, provider: user.provider, status: normalizeAdminStatus(user.status), created_at: user.created_at, last_login: user.last_login },
      trips: trips.results || [],
      waypoints: waypoints.results || [],
      journals: journals.results || [],
      images,
      identities: identities.results || [],
      logins: logins.results || [],
      notes: notes.results || [],
      flags,
    });
  },

  /**
  * Admin: update user status (active / paused / blocked)
   */
  async setUserStatus(context) {
    const { env, params, request } = context;
    const userId = params.id;
    const { body, error } = await readJsonBody(request);
    if (error) return error;
    const { status, reason } = body;
    const adminEmail = context.user?.email || 'admin';
    const normalizedStatus = normalizeAdminStatus(status);

    if (!isAllowedAdminStatus(status)) {
      return errorResponse('Invalid status. Must be active, paused, or blocked.', 400);
    }

    const db = env.RIDE_TRIP_PLANNER_DB;
    const user = await db.prepare('SELECT id, email, status FROM users WHERE id = ?').bind(userId).first();
    if (!user) return errorResponse('User not found', 404);

    // Update status
    await db.prepare('UPDATE users SET status = ?, updated_at = datetime("now") WHERE id = ?').bind(normalizedStatus, userId).run();

    // Record admin note
    const noteId = generateId();
    const actionLabel = normalizedStatus === 'active' ? 'restore' : normalizedStatus;
    await db.prepare(
      'INSERT INTO admin_notes (id, user_id, admin_email, action, content, created_at) VALUES (?, ?, ?, ?, ?, datetime("now"))'
    ).bind(noteId, userId, adminEmail || 'admin', actionLabel, reason || `Status changed to ${normalizedStatus}`).run();

    // If banning/suspending, revoke all sessions
    if (normalizedStatus !== 'active') {
      try {
        const registryKey = `sessions:${userId}`;
        const raw = await env.RIDE_TRIP_PLANNER_SESSIONS.get(registryKey, 'json');
        if (Array.isArray(raw)) {
          await Promise.all(raw.map(s => env.RIDE_TRIP_PLANNER_SESSIONS.delete(s.token)));
          await env.RIDE_TRIP_PLANNER_SESSIONS.delete(registryKey);
        }
      } catch (_) { /* best effort */ }
    }

    return jsonResponse({ ok: true, status: normalizedStatus, userId });
  },

  /**
   * Admin: add a note to a user's record
   */
  async addAdminNote(context) {
    const { env, params, request } = context;
    const userId = params.id;
    const { body, error } = await readJsonBody(request);
    if (error) return error;
    const { content } = body;
    const adminEmail = context.user?.email || 'admin';
    if (!content) return errorResponse('Note content is required', 400);

    const db = env.RIDE_TRIP_PLANNER_DB;
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
    if (!user) return errorResponse('User not found', 404);

    const noteId = generateId();
    await db.prepare(
      'INSERT INTO admin_notes (id, user_id, admin_email, action, content, created_at) VALUES (?, ?, ?, ?, ?, datetime("now"))'
    ).bind(noteId, userId, adminEmail || 'admin', 'note', content).run();

    const note = await db.prepare('SELECT id, admin_email, action, content, created_at, updated_at FROM admin_notes WHERE id = ?').bind(noteId).first();
    return jsonResponse({ ok: true, note });
  },

  /**
   * Admin: update an existing note on a user's record
   */
  async updateAdminNote(context) {
    const { env, params, request } = context;
    const { body, error } = await readJsonBody(request);
    if (error) return error;
    const content = (body.content || '').trim();
    const adminEmail = context.user?.email || 'admin';
    if (!content) return errorResponse('Note content is required', 400);

    const db = env.RIDE_TRIP_PLANNER_DB;
    const note = await db.prepare('SELECT id, user_id FROM admin_notes WHERE id = ? AND user_id = ?').bind(params.noteId, params.id).first();
    if (!note) return errorResponse('Note not found', 404);

    try {
      await db.prepare(
        'UPDATE admin_notes SET content = ?, admin_email = ?, updated_at = datetime("now") WHERE id = ? AND user_id = ?'
      ).bind(content, adminEmail, params.noteId, params.id).run();
    } catch (_) {
      await db.prepare(
        'UPDATE admin_notes SET content = ?, admin_email = ? WHERE id = ? AND user_id = ?'
      ).bind(content, adminEmail, params.noteId, params.id).run();
    }

    const updated = await db.prepare('SELECT id, admin_email, action, content, created_at, updated_at FROM admin_notes WHERE id = ?').bind(params.noteId).first();
    return jsonResponse({ ok: true, note: updated });
  },
};

/* ── Content analysis ────────────────────────────────────── */

const PROPRIETARY_PATTERNS = /\u00a9|\u00ae|\u2122|\btrademark\b|\bpatent\b|\bcopyrighted\b|\ball rights reserved\b|\bconfidential\b|\bproprietary\b/i;
const SPAM_PATTERNS = /\b(buy now|click here|free money|act now|limited offer|subscribe|unsubscribe|\$\$\$)\b/i;
const IMPERSONATION_PATTERNS = /\b(official|verified|admin|support team|customer service|helpdesk)\b/i;
const OFFENSIVE_PATTERNS = /\b(hate|kill|threat|bomb|attack|terror)\b/i;
const URL_PATTERN = /https?:\/\/[^\s]{20,}/gi;

function scanContent({ user, trips, waypoints, journals, attachments }) {
  const flags = [];

  // Collect all text fields
  function check(source, field, text) {
    if (!text) return;
    if (PROPRIETARY_PATTERNS.test(text)) flags.push({ severity: 'warning', category: 'proprietary', source, field, snippet: text.slice(0, 120) });
    if (SPAM_PATTERNS.test(text)) flags.push({ severity: 'info', category: 'spam', source, field, snippet: text.slice(0, 120) });
    if (IMPERSONATION_PATTERNS.test(text)) flags.push({ severity: 'warning', category: 'impersonation', source, field, snippet: text.slice(0, 120) });
    if (OFFENSIVE_PATTERNS.test(text)) flags.push({ severity: 'alert', category: 'offensive', source, field, snippet: text.slice(0, 120) });
    const urls = text.match(URL_PATTERN);
    if (urls && urls.length > 2) flags.push({ severity: 'info', category: 'link-heavy', source, field, snippet: urls.slice(0, 3).join(', ') });
  }

  // User profile
  check('profile', 'name', user.name);

  // Trips
  for (const t of trips) {
    check(`trip:${t.id}`, 'name', t.name);
    check(`trip:${t.id}`, 'description', t.description);
    check(`trip:${t.id}`, 'public_title', t.public_title);
    check(`trip:${t.id}`, 'public_description', t.public_description);
    check(`trip:${t.id}`, 'public_contact', t.public_contact);
  }

  // Waypoints
  for (const w of waypoints) {
    check(`waypoint:${w.id}`, 'name', w.name);
    check(`waypoint:${w.id}`, 'notes', w.notes);
  }

  // Journal entries
  for (const j of journals) {
    check(`journal:${j.id}`, 'title', j.title);
    check(`journal:${j.id}`, 'content', j.content);
  }

  // Attachment filenames / captions
  for (const a of attachments) {
    check(`attachment:${a.id}`, 'original_name', a.original_name);
    check(`attachment:${a.id}`, 'caption', a.caption);
  }

  return flags;
}

async function recordLogin(env, user, provider, request) {
  const ip = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || 'unknown';
  const userAgent = request.headers.get('user-agent') || '';
  const id = generateId();

  const clientHints = {
    ua: request.headers.get('sec-ch-ua') || undefined,
    uaPlatform: request.headers.get('sec-ch-ua-platform') || undefined,
    uaMobile: request.headers.get('sec-ch-ua-mobile') || undefined,
    acceptLanguage: request.headers.get('accept-language') || undefined,
    cfRay: request.headers.get('cf-ray') || undefined,
    cfCountry: request.headers.get('cf-ipcountry') || undefined
  };

  // Backward compatible: if extra columns don't exist yet, fall back to the base insert.
  try {
    await env.RIDE_TRIP_PLANNER_DB.prepare(
      'INSERT INTO login_events (id, user_id, email, provider, provider_id, ip, user_agent, client_hints) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, user.id, user.email, provider, user.provider_id || null, ip, userAgent, JSON.stringify(clientHints)).run();
  } catch (err) {
    await env.RIDE_TRIP_PLANNER_DB.prepare(
      'INSERT INTO login_events (id, user_id, email, provider, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, user.id, user.email, provider, ip, userAgent).run();
  }
}

/**
 * Raised when an OAuth login would attach a provider identity to a pre-existing
 * account purely because the email strings match, without the provider having
 * proved the signer actually owns that address.
 */
function unverifiedLinkError() {
  const err = new Error('Refusing to link accounts on an unverified email');
  err.code = 'UNVERIFIED_EMAIL_LINK';
  return err;
}

/**
 * Create or update user in database.
 *
 * Identity resolution order — email is the LAST resort and only when the
 * provider vouched for it:
 *   1. auth_identities row for (provider, provider_id)  — the immutable subject
 *   2. legacy users row for (provider, provider_id)     — backfills an identity
 *   3. users row for the email, ONLY if emailVerified   — cross-provider link
 *   4. otherwise create a brand new user
 */
async function createOrUpdateUser(db, userData) {
  const { email, name, avatar_url, provider, provider_id, emailVerified } = userData;
  const normalizedEmail = email?.toLowerCase();
  const emailIsProven = emailVerified === true;

  // Prefer the linked identities table if present.
  try {
    const existingIdentity = await db.prepare(
      'SELECT u.* FROM auth_identities ai JOIN users u ON ai.user_id = u.id WHERE ai.provider = ? AND ai.provider_id = ?'
    ).bind(provider, provider_id).first();

    if (existingIdentity) {
      // Only overwrite avatar_url if the new provider actually supplies one
      const effectiveAvatar = avatar_url || existingIdentity.avatar_url;
      await db.prepare(
        'UPDATE users SET email = ?, name = ?, avatar_url = COALESCE(?, avatar_url), last_login = datetime("now"), updated_at = datetime("now") WHERE id = ?'
      ).bind(normalizedEmail, name, avatar_url, existingIdentity.id).run();

      await db.prepare(
        'UPDATE auth_identities SET email = ?, last_login = datetime("now") WHERE provider = ? AND provider_id = ?'
      ).bind(normalizedEmail, provider, provider_id).run();

      return { ...existingIdentity, email: normalizedEmail, name, avatar_url: effectiveAvatar, provider, provider_id, last_login: new Date().toISOString() };
    }

    // Legacy accounts created before auth_identities existed still carry the
    // provider subject on the users row. Matching on it is safe (the subject is
    // immutable and provider-issued) and backfills the missing identity row, so
    // long-standing Microsoft users are not locked out by the email rule below.
    const legacyByProvider = await db.prepare(
      'SELECT * FROM users WHERE provider = ? AND provider_id = ?'
    ).bind(provider, provider_id).first();

    if (legacyByProvider) {
      try {
        await db.prepare(
          'INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, last_login) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))'
        ).bind(generateId(), legacyByProvider.id, provider, provider_id, normalizedEmail).run();
      } catch (_) {
        // Already present (concurrent login) — nothing to do.
      }

      const effectiveAvatar = avatar_url || legacyByProvider.avatar_url;
      await db.prepare(
        'UPDATE users SET name = ?, avatar_url = COALESCE(?, avatar_url), last_login = datetime("now"), updated_at = datetime("now") WHERE id = ?'
      ).bind(name, avatar_url, legacyByProvider.id).run();

      return { ...legacyByProvider, name, avatar_url: effectiveAvatar, provider, provider_id, last_login: new Date().toISOString() };
    }

    const existingUser = await db.prepare('SELECT * FROM users WHERE email = ?').bind(normalizedEmail).first();
    if (existingUser) {
      // An account already owns this address and the provider subject is new.
      // Linking here is only safe when the provider proved address ownership —
      // otherwise anyone who can set an email attribute in their own directory
      // could sign in straight into someone else's Ride account (nOAuth).
      if (!emailIsProven) throw unverifiedLinkError();

      // Link this provider identity to the existing user (one user per email).
      try {
        await db.prepare(
          'INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, last_login) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))'
        ).bind(generateId(), existingUser.id, provider, provider_id, normalizedEmail).run();
      } catch (_) {
        // Ignore if a concurrent login already inserted it.
      }

      const effectiveAvatar = avatar_url || existingUser.avatar_url;
      await db.prepare(
        'UPDATE users SET name = ?, avatar_url = COALESCE(?, avatar_url), last_login = datetime("now"), updated_at = datetime("now") WHERE id = ?'
      ).bind(name, avatar_url, existingUser.id).run();

      return { ...existingUser, name, avatar_url: effectiveAvatar, provider, provider_id, last_login: new Date().toISOString() };
    }

    // Create new user + first linked identity.
    const id = generateId();
    await db.prepare(
      'INSERT INTO users (id, email, name, avatar_url, provider, provider_id, last_login) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))'
    ).bind(id, normalizedEmail, name, avatar_url, provider, provider_id).run();

    await db.prepare(
      'INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, last_login) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))'
    ).bind(generateId(), id, provider, provider_id, normalizedEmail).run();

    return { id, email: normalizedEmail, name, avatar_url, provider, provider_id, last_login: new Date().toISOString() };
  } catch (err) {
    // A refused link is a decision, not a schema problem — never let the legacy
    // fallback below re-link the account by email behind our back.
    if (err?.code === 'UNVERIFIED_EMAIL_LINK') throw err;

    // Legacy fallback (no auth_identities table yet): keep one account per email by reusing existing user.

    // First try provider+id match
    const existingByProvider = await db.prepare(
      'SELECT * FROM users WHERE provider = ? AND provider_id = ?'
    ).bind(provider, provider_id).first();

    if (existingByProvider) {
      const effectiveAvatar = avatar_url || existingByProvider.avatar_url;
      await db.prepare(
        'UPDATE users SET email = ?, name = ?, avatar_url = COALESCE(?, avatar_url), last_login = datetime("now"), updated_at = datetime("now") WHERE id = ?'
      ).bind(normalizedEmail, name, avatar_url, existingByProvider.id).run();
      return { ...existingByProvider, email: normalizedEmail, name, avatar_url: effectiveAvatar, provider, provider_id, last_login: new Date().toISOString() };
    }

    // Then try email match to merge accounts across providers
    const existingByEmail = await db.prepare('SELECT * FROM users WHERE email = ?').bind(normalizedEmail).first();

    if (existingByEmail) {
      // Same rule as the primary path: an unproven email must never adopt an
      // existing account, even in legacy single-identity mode.
      if (!emailIsProven) throw unverifiedLinkError();

      // IMPORTANT: do not create a second user for the same email.
      // In legacy mode we cannot persist multiple identities, so we keep the existing user record.
      const effectiveAvatar = avatar_url || existingByEmail.avatar_url;
      await db.prepare(
        'UPDATE users SET name = ?, avatar_url = COALESCE(?, avatar_url), last_login = datetime("now"), updated_at = datetime("now") WHERE id = ?'
      ).bind(name, avatar_url, existingByEmail.id).run();
      return { ...existingByEmail, name, avatar_url: effectiveAvatar, provider, provider_id, last_login: new Date().toISOString() };
    }

    // Create new user
    const id = generateId();
    await db.prepare(
      'INSERT INTO users (id, email, name, avatar_url, provider, provider_id, last_login) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))'
    ).bind(id, normalizedEmail, name, avatar_url, provider, provider_id).run();

    return { id, email: normalizedEmail, name, avatar_url, provider, provider_id, last_login: new Date().toISOString() };
  }
}
