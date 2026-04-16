# Users & Authentication

Lumiverse supports multiple users with role-based access control. The first account created during setup is the **owner** — the top-level admin.

---

## Roles

| Role | Capabilities |
|------|-------------|
| **Owner** | Full control — created during first-run setup |
| **Admin** | Can create users, reset passwords, ban/unban, delete users |
| **User** | Standard access — can use all chat features, manage their own data |

---

## Creating Users (Admin/Owner Only)

1. Open **Settings > Users**
2. Click **Add User**
3. Enter a username and password
4. Select a role: **User** or **Admin**
5. Click **Create**

The new user can log in immediately with those credentials.

---

## Managing Users

Admins and owners can:

- **Reset password** — Set a new password for any user
- **Ban/unban** — Prevent a user from logging in (or restore access)
- **Delete** — Remove a user and their data permanently

---

## Changing Your Password

Every user can change their own password:

1. Open **Settings > Users**
2. Click **Change Password**
3. Enter your current password and the new password
4. Confirm

---

## Data Isolation

Each user's data is scoped to their account:

- Characters, chats, personas, presets, connections, and world books are per-user
- Uploaded files are stored in user-specific directories
- API keys are encrypted per-user
- Extensions can be scoped per-user or system-wide (operator-scoped)

---

## Password Reset (CLI)

If you're locked out, reset the owner password from the command line:

```bash
bun run reset-password
```
