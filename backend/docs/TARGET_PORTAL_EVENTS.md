# Target Portal Integration Spec

How a target portal (React/Vue SPA + any backend: Node, PHP, …) receives
identity, role, and revocation from the Identity Center.

A portal integrates through three channels. Use all three for instant,
reliable revocation:

| Channel | Direction | Purpose |
|---|---|---|
| **Access events** (webhook) | Identity Center → portal | Push: "user X is now INACTIVE / role changed". Kill sessions immediately. |
| **Portal JWT** (RS256) | User → portal | Who the user is, their role and permissions in *this* portal. TTL 15 min. |
| **Introspection** | Portal → Identity Center | Optional live check: "is this token still valid right now?" |
| **Roles endpoint** | Identity Center → portal | The portal lists its own roles; the SaaS uses them when admins assign users. |

---

## 1. Access events (webhook)

The Identity Center `POST`s to the portal's `portals.webhook_url` whenever a
user's effective access to **that portal** changes.

### Event types

| `type` | When |
|---|---|
| `access.granted` | Access turned ON, first grant, or account re-activated in EMS |
| `access.revoked` | Access turned OFF, or account deactivated/deleted in EMS |
| `access.role_changed` | Portal role changed while access is ON |
| `user.updated` | Profile changed (name, email, department, designation, deployment). Access unchanged. |

### Headers

```
Content-Type:      application/json
X-IAM-Event-Id:    2b0f6a0e-6a8e-4a43-9a43-7b1f2a0c9d11
X-IAM-Event-Type:  access.revoked
X-IAM-Timestamp:   1791370000
X-IAM-Signature:   v1=5d41402abc4b2a76b9719d911017c592...
```

`signature = hex(HMAC_SHA256(portal.webhook_secret, "<X-IAM-Timestamp>.<raw body>"))`

### Payload: user toggled to INACTIVE

```json
{
  "id": "2b0f6a0e-6a8e-4a43-9a43-7b1f2a0c9d11",
  "type": "access.revoked",
  "api_version": "2026-10-01",
  "occurred_at": "2026-10-07T11:42:05.118Z",
  "reason": "ADMIN_ACTION",
  "portal": { "code": "CONTENT" },
  "user": {
    "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "ems_user_id": 101,
    "staff_id": "EMP101",
    "email": "ayesha@company.com",
    "full_name": "Ayesha Khan",
    "source": "EMS",
    "department": "Engineering",
    "designation": "Senior Developer",
    "deployed_project": "Apollo",
    "deployed_location": "Lahore HQ"
  },
  "access": {
    "status": "INACTIVE",
    "portal_flag_active": false,
    "account_status": "ACTIVE",
    "role": {
      "code": "EDITOR",
      "name": "Editor",
      "permissions": ["content.read", "content.write"]
    },
    "version": 7,
    "previous": { "status": "ACTIVE", "role": "EDITOR" }
  },
  "directives": {
    "terminate_sessions": true,
    "reject_tokens_with_version_below": 7
  },
  "actor": { "id": "0d3c…", "label": "admin@company.com" }
}
```

### Payload: role modified

```json
{
  "id": "e3f1c2d4-…",
  "type": "access.role_changed",
  "api_version": "2026-10-01",
  "occurred_at": "2026-10-07T11:45:51.004Z",
  "reason": "ADMIN_ACTION",
  "portal": { "code": "CONTENT" },
  "user": { "id": "7c9e6679-…", "email": "ayesha@company.com", "full_name": "Ayesha Khan", "source": "EMS", "...": "..." },
  "access": {
    "status": "ACTIVE",
    "portal_flag_active": true,
    "account_status": "ACTIVE",
    "role": {
      "code": "ADMIN",
      "name": "Admin",
      "permissions": ["content.read", "content.write", "content.publish", "users.manage"]
    },
    "version": 8,
    "previous": { "status": "ACTIVE", "role": "EDITOR" }
  },
  "directives": { "terminate_sessions": false, "reject_tokens_with_version_below": 8 },
  "actor": { "id": "0d3c…", "label": "admin@company.com" }
}
```

### Field reference

| Field | Meaning |
|---|---|
| `access.status` | **Effective** status for this portal: `ACTIVE` only if the account is ACTIVE **and** the portal flag is on. Act on this. |
| `access.portal_flag_active` | The per-portal toggle in the dashboard. |
| `access.account_status` | Global account status. `INACTIVE` (e.g. deactivated in EMS) blocks every portal. |
| `access.version` | Monotonic per (user, portal). Matches the `ver` claim in portal JWTs. |
| `reason` | `ADMIN_ACTION`, `USER_CREATED`, `EMS_DEACTIVATED`, `EMS_REACTIVATED`, `EMS_DELETED`, `PROFILE_CHANGED` |

### Portal obligations

1. **Verify** the signature and reject timestamps older than 5 minutes.
2. **Deduplicate** by `id`. Delivery is at-least-once, so the same event can arrive twice.
3. **Ignore out-of-date events**: if `access.version` < the version you last stored for this user, drop it. (`user.updated` carries the current version, so it is equal, not lower.)
4. On `directives.terminate_sessions = true`: delete the user's server sessions and refresh tokens, and store `reject_tokens_with_version_below` so in-flight JWTs with a lower `ver` are refused.
5. Respond **2xx within 10 s**. Anything else is retried with exponential backoff (30 s → 1 h, 12 attempts). Events for one user are delivered **in order**: a newer event waits until the older one succeeds.

---

## 2. Portal JWT

```
POST /api/v1/auth/token
{ "email": "ayesha@company.com", "password": "…", "portal_code": "CONTENT" }

200 { "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 900,
      "portal": "CONTENT", "role": "EDITOR", "permissions": ["content.read","content.write"] }
```

Decoded claims:

```json
{
  "iss": "https://identity.example.com",
  "aud": "CONTENT",
  "sub": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "jti": "…",
  "iat": 1791370000,
  "exp": 1791370900,
  "email": "ayesha@company.com",
  "name": "Ayesha Khan",
  "src": "EMS",
  "ems_user_id": 101,
  "department": "Engineering",
  "designation": "Senior Developer",
  "portal": "CONTENT",
  "role": "EDITOR",
  "permissions": ["content.read", "content.write"],
  "ver": 7
}
```

Verify with the public keys at `GET /.well-known/jwks.json` (cache 5 min).
Check `iss`, `aud == <your portal code>`, `exp`, and `ver >= reject_tokens_with_version_below`.
The EMS role is **never** in this token. Portal authorisation uses `role` / `permissions` only.

---

## 3. Introspection (optional live check)

```
POST /api/v1/auth/introspect
Authorization: Basic base64("CONTENT:<webhook_secret>")
{ "token": "eyJ…" }

200 { "active": true, "sub": "…", "role": "EDITOR", "permissions": [...], "ver": 7, "exp": 1791370900 }
200 { "active": false, "reason": "PORTAL_ACCESS_INACTIVE" }   // or ACCOUNT_INACTIVE, ACCESS_CHANGED, NO_ACCESS, INVALID_OR_EXPIRED
```

Use it for sensitive operations, or cache it for 30–60 s per token. Portals
without a webhook should use it; their revocation is otherwise only as fast
as the 15-minute token TTL.

---

## Reference receivers

### Node.js / Express

```js
import crypto from 'node:crypto';
import express from 'express';

const app = express();
app.post('/iam/events', express.raw({ type: 'application/json' }), async (req, res) => {
  const ts = req.get('X-IAM-Timestamp');
  const sig = (req.get('X-IAM-Signature') ?? '').replace(/^v1=/, '');
  const expected = crypto.createHmac('sha256', process.env.IAM_WEBHOOK_SECRET)
    .update(`${ts}.${req.body}`).digest('hex');

  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  if (!fresh || sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
    return res.sendStatus(401);
  }

  const event = JSON.parse(req.body);
  if (await seenEvent(event.id)) return res.sendStatus(204);              // dedupe
  if (event.access.version < await storedVersion(event.user.id)) return res.sendStatus(204); // stale

  await upsertLocalUser(event.user, event.access);                         // role, permissions, status
  if (event.directives.terminate_sessions) await destroySessionsFor(event.user.id);
  await rememberVersion(event.user.id, event.directives.reject_tokens_with_version_below);
  res.sendStatus(204);
});
```

### PHP / Laravel

```php
Route::post('/iam/events', function (Illuminate\Http\Request $request) {
    $raw = $request->getContent();
    $ts  = $request->header('X-IAM-Timestamp');
    $sig = preg_replace('/^v1=/', '', (string) $request->header('X-IAM-Signature'));
    $expected = hash_hmac('sha256', $ts.'.'.$raw, config('services.iam.webhook_secret'));

    if (abs(time() - (int) $ts) > 300 || ! hash_equals($expected, $sig)) {
        abort(401);
    }

    $event = json_decode($raw, true);
    if (! Cache::add('iam-event:'.$event['id'], 1, now()->addDay())) {
        return response()->noContent();                  // duplicate delivery
    }

    $user = App\Models\User::firstOrNew(['iam_id' => $event['user']['id']]);
    if ($user->exists && $event['access']['version'] < $user->iam_access_version) {
        return response()->noContent();                  // out-of-date event
    }

    $user->fill([
        'email'              => $event['user']['email'],
        'name'               => $event['user']['full_name'],
        'role'               => $event['access']['role']['code'],
        'is_active'          => $event['access']['status'] === 'ACTIVE',
        'iam_access_version' => $event['access']['version'],
    ])->save();

    if ($event['directives']['terminate_sessions']) {
        DB::table('sessions')->where('user_id', $user->id)->delete();
        $user->tokens()->delete();                       // Sanctum tokens, if used
    }

    return response()->noContent();
})->withoutMiddleware([\App\Http\Middleware\VerifyCsrfToken::class]);
```

---

## 4. Roles endpoint (portal-owned roles)

Every portal has its own roles. When a portal is connected with
**Roles come from: From the portal**, the Identity Center reads them from the
portal instead of having an admin type them in:

- right after the portal is added (fails until the portal has its secret — that is expected),
- when an admin clicks **Fetch roles now** on the portal's Roles tab,
- automatically every 15 minutes,
- and whenever the portal **pushes** its roles (recommended after any role change).

### Pull: `GET <roles URL>` (the portal implements this)

Request headers (empty body):

```
X-IAM-Portal:     BLOG
X-IAM-Timestamp:  1791370000
X-IAM-Signature:  v1=hex(HMAC_SHA256(portal_secret, "<timestamp>."))
```

Response `200`:

```json
{
  "roles": [
    { "id": "editor", "name": "Editor", "permissions": ["post.edit", "post.publish"] },
    { "id": "viewer", "name": "Viewer" }
  ]
}
```

Accepted variations: a bare array, `{ "data": [...] }`, `id` may be `code`/`key`/`slug`/`value`,
`name` may be `label`/`title`/`display_name`, `permissions` may be `abilities`/`scopes` and may hold
objects with a `name`. Max 500 roles.

### Push: `POST /api/v1/portal-sync/roles` (the portal calls this)

`Authorization: Basic base64("<PORTAL_CODE>:<portal_secret>")`, same JSON body as above.

### How the roles are used

- Each role keeps the portal's own `id`. It is sent back to the portal as `role_id` in tokens
  and as `access.role.external_id` in events, so the portal never needs to translate codes.
- Renaming a role in the portal renames it in the SaaS (linked by id). A role removed from the
  portal disappears from the SaaS, unless users still have it; then it stays until an admin moves them.

### Node.js / Express

```js
app.get('/iam/roles', async (req, res) => {
  const ts = req.get('X-IAM-Timestamp');
  const expected = crypto.createHmac('sha256', process.env.IAM_PORTAL_SECRET).update(`${ts}.`).digest('hex');
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300 || req.get('X-IAM-Signature') !== `v1=${expected}`) {
    return res.sendStatus(401);
  }
  res.json({ roles: await Role.findAll().then((rs) => rs.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions }))) });
});
```

### PHP / Laravel (Spatie roles)

```php
Route::get('/iam/roles', function (Illuminate\Http\Request $request) {
    $ts = (string) $request->header('X-IAM-Timestamp');
    $expected = 'v1='.hash_hmac('sha256', $ts.'.', config('services.iam.secret'));
    abort_unless(abs(time() - (int) $ts) <= 300 && hash_equals($expected, (string) $request->header('X-IAM-Signature')), 401);

    return ['roles' => Spatie\Permission\Models\Role::with('permissions')->get()->map(fn ($r) => [
        'id' => (string) $r->id,
        'name' => $r->name,
        'permissions' => $r->permissions->pluck('name'),
    ])];
});
```
