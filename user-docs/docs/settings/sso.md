---
title: Single Sign-On
---

# Single Sign-On

Owners can connect Lumiverse to an OpenID Connect identity provider so users can sign in with SSO. Lumiverse currently supports provider templates for **authentik**, **Authelia**, and **Keycloak**.

SSO is intentionally safe-by-default:

- SSO does **not** create users automatically.
- SSO does **not** auto-link accounts by matching email addresses.
- A user must first exist in Lumiverse, sign in locally, and explicitly link their SSO identity.
- Keep at least one owner account with a local password as break-glass recovery.

---

## Before You Start

You need:

1. A working Lumiverse instance reachable at a stable public URL, such as `https://app.example.com`.
2. Owner access in Lumiverse.
3. Admin access in your identity provider.
4. Lumiverse configured with the same public URL used by browsers.

Set this environment variable on the Lumiverse server:

```bash
AUTH_BASE_URL=https://app.example.com
```

Restart Lumiverse after changing it.

If `AUTH_BASE_URL` is missing, Lumiverse may fall back to `http://localhost:7860`, which causes OIDC providers to reject the redirect URI.

---

## Lumiverse Setup

1. Sign in to Lumiverse as the owner using the local password.
2. Open **Settings > SSO**.
3. Choose a provider template: **authentik**, **Authelia**, or **Keycloak**.
4. Fill in:
   - **Name**: Friendly display name, such as `authentik`.
   - **Slug**: Stable provider ID, such as `authentik`, `authelia`, or `keycloak`.
   - **Issuer URL**: The OIDC issuer from your provider.
   - **Discovery URL**: Usually leave blank. Lumiverse derives `/.well-known/openid-configuration` from the issuer URL.
   - **Public Lumiverse Origin**: Your Lumiverse origin, such as `https://app.example.com`.
   - **Client ID**: From your identity provider.
   - **Client Secret**: From your identity provider.
   - **Scopes**: `openid profile email`.
5. Click **Test Discovery**.
6. Enable the provider.
7. Save.
8. Restart Lumiverse.
9. Return to **Settings > SSO** and verify the provider row says **Active**.
10. Copy the displayed **Redirect** URI into your identity provider.

The redirect URI format is:

```text
https://app.example.com/api/auth/oauth2/callback/<slug>
```

For example:

```text
https://app.example.com/api/auth/oauth2/callback/authentik
```

The redirect URI must match exactly: scheme, host, port, path, and slug.

---

## Link Your Owner Account

After the provider is active:

1. Sign in to Lumiverse with the local owner password.
2. Open **Settings > SSO**.
3. In **Configured Providers**, click the link icon for your provider.
4. Complete the identity-provider authorization flow.
5. Lumiverse returns to the SSO settings page and shows the linked identity.

Only after this link exists can that Lumiverse account sign in through SSO.

---

## Add SSO for Other Users

The current SSO setup is owner-scoped. Use it first to link and validate the owner account.

For broader user rollout, create local users normally in **Settings > Users** and keep local passwords available. Do not require SSO for standard users until your Lumiverse version includes an explicit user-linking or provisioning flow for non-owner accounts.

Recommended rollout order:

1. Create the user locally in **Settings > Users**.
2. Keep username/password login available.
3. Validate SSO with the owner account.
4. Only expand SSO use once every affected account has a deliberate account-link path.

Do not delete or disable all local owner credentials. Keep a recovery path.

---

## authentik Setup

In authentik, create an OAuth2/OpenID provider and application for Lumiverse.

### 1. Create the Provider

1. In authentik, go to **Applications > Providers**.
2. Click **Create**.
3. Select **OAuth2/OpenID Provider**.
4. Configure:
   - **Name**: `Lumiverse`.
   - **Client type**: `Confidential`.
   - **Client ID**: Generate or enter a stable value.
   - **Client Secret**: Generate a secret and copy it into Lumiverse.
   - **Redirect URIs/Origins**: Add the Lumiverse redirect URI exactly.
   - **Signing Key**: Use authentik's default signing key unless you have a custom policy.
   - **Subject mode**: Use a stable subject, usually based on the user's ID.
5. Save.

Example redirect URI:

```text
https://app.example.com/api/auth/oauth2/callback/authentik
```

### 2. Create the Application

1. Go to **Applications > Applications**.
2. Click **Create**.
3. Configure:
   - **Name**: `Lumiverse`.
   - **Slug**: `lumiverse`.
   - **Provider**: Select the provider created above.
4. Save.

### 3. Lumiverse Values

Use these values in **Settings > SSO**:

| Lumiverse Field | Value |
|-----------------|-------|
| Provider | `authentik` |
| Slug | `authentik` |
| Issuer URL | `https://auth.example.com/application/o/lumiverse/` |
| Scopes | `openid profile email` |
| Public Lumiverse Origin | `https://app.example.com` |

Replace `auth.example.com`, `lumiverse`, and `app.example.com` with your actual domains and authentik application slug.

---

## Authelia Setup

In Authelia, add Lumiverse as an OpenID Connect client.

### 1. Configure the OIDC Client

Add a client entry to Authelia's OpenID Connect configuration. The exact file structure depends on your Authelia version and deployment style, but the client needs these values:

```yaml
client_id: lumiverse
client_name: Lumiverse
client_secret: <hashed-or-digested-secret-required-by-your-authelia-version>
redirect_uris:
  - https://app.example.com/api/auth/oauth2/callback/authelia
scopes:
  - openid
  - profile
  - email
grant_types:
  - authorization_code
response_types:
  - code
token_endpoint_auth_method: client_secret_basic
```

Authelia requires client secrets in the format expected by your Authelia version. Follow Authelia's documentation for generating the secret digest/hash.

Restart or reload Authelia after changing its configuration.

### 2. Lumiverse Values

Use these values in **Settings > SSO**:

| Lumiverse Field | Value |
|-----------------|-------|
| Provider | `Authelia` |
| Slug | `authelia` |
| Issuer URL | Your Authelia issuer, commonly `https://auth.example.com` |
| Scopes | `openid profile email` |
| Public Lumiverse Origin | `https://app.example.com` |

Then save, restart Lumiverse, and link the owner account.

---

## Keycloak Setup

In Keycloak, create a confidential OIDC client in the realm that should authenticate Lumiverse users.

### 1. Create the Client

1. In Keycloak, select the target realm.
2. Go to **Clients**.
3. Click **Create client**.
4. Configure:
   - **Client type**: `OpenID Connect`.
   - **Client ID**: `lumiverse`.
   - **Name**: `Lumiverse`.
5. Enable:
   - **Standard flow**.
   - **Client authentication**.
6. Save.

### 2. Configure Redirects

In the client settings, set:

| Keycloak Field | Value |
|----------------|-------|
| Valid redirect URIs | `https://app.example.com/api/auth/oauth2/callback/keycloak` |
| Web origins | `https://app.example.com` |

Avoid wildcards for production if possible.

### 3. Get the Client Secret

1. Open the client.
2. Go to **Credentials**.
3. Copy the client secret into Lumiverse.

### 4. Lumiverse Values

Use these values in **Settings > SSO**:

| Lumiverse Field | Value |
|-----------------|-------|
| Provider | `Keycloak` |
| Slug | `keycloak` |
| Issuer URL | `https://keycloak.example.com/realms/<realm>` |
| Scopes | `openid profile email` |
| Public Lumiverse Origin | `https://app.example.com` |

The Keycloak issuer is realm-specific. For example:

```text
https://keycloak.example.com/realms/main
```

---

## PWA and Mobile Behavior

Lumiverse opens SSO authorization in a popup or separate window where possible. This prevents the installed PWA from losing its current route during authorization.

On mobile platforms, the identity provider may open in an external browser or system web view. After authorization completes, Lumiverse attempts to notify the original app window and refresh the session or linked-account state.

If your mobile browser blocks popups, Lumiverse may fall back to same-tab navigation.

---

## Troubleshooting

### Authentik says `missing, invalid, or mismatching redirection URI`

The `redirect_uri` sent by Lumiverse does not exactly match the URI registered in authentik.

Check:

1. `AUTH_BASE_URL` is set on the Lumiverse server:

   ```bash
   AUTH_BASE_URL=https://app.example.com
   ```

2. **Settings > SSO > Public Lumiverse Origin** is the same origin:

   ```text
   https://app.example.com
   ```

3. Lumiverse was restarted after saving the SSO provider.
4. The provider row says **Active**, not **Restart needed**.
5. The provider row's **Redirect** value exactly matches the provider's allowed redirect URI.
6. The provider slug in Lumiverse matches the path in the redirect URI.

For example, slug `authentik` requires:

```text
https://app.example.com/api/auth/oauth2/callback/authentik
```

### The SSO button does not appear on the login page

The provider must be both enabled and active. Save the provider, restart Lumiverse, then check **Settings > SSO**.

### Login says signup is disabled

This is expected if the SSO identity is not linked to an existing Lumiverse account. Sign in locally first, then link the SSO provider from **Settings > SSO**.

### The owner is not in the identity provider

Keep using the local owner password. Do not remove the local owner credential. Add the owner to the identity provider and link the identity only after you can complete a successful provider login.

### I changed the redirect URI and it still uses the old one

BetterAuth loads SSO providers at Lumiverse startup. Save the provider and restart Lumiverse. The startup log shows active redirect URIs:

```text
[Auth] SSO authentik redirect URI: https://app.example.com/api/auth/oauth2/callback/authentik
```
