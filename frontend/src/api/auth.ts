import { createAuthClient } from "better-auth/react";
import { usernameClient, adminClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [usernameClient(), adminClient()],
});

export const { signIn, signOut, signUp, useSession } = authClient;
