type IllarinPermission = "work:receive" | "library:sync";

const permissionErrors = new Map<string, Set<IllarinPermission>>();

export function getPermissionError(userId: string): string | null {
  const errors = permissionErrors.get(userId);
  if (!errors || errors.size === 0) return null;
  // Receiving work is the primary user-facing function, so show it first if
  // both permissions have independently failed.
  return errors.has("work:receive") ? "work:receive" : "library:sync";
}

export function hasPermissionError(userId: string, permission: IllarinPermission): boolean {
  return permissionErrors.get(userId)?.has(permission) ?? false;
}

export function setPermissionError(userId: string, permission: IllarinPermission): void {
  const errors = permissionErrors.get(userId) ?? new Set<IllarinPermission>();
  errors.add(permission);
  permissionErrors.set(userId, errors);
}

export function clearPermissionError(userId: string, permission?: IllarinPermission): void {
  if (!permission) {
    permissionErrors.delete(userId);
    return;
  }
  const errors = permissionErrors.get(userId);
  if (!errors) return;
  errors.delete(permission);
  if (errors.size === 0) permissionErrors.delete(userId);
}
