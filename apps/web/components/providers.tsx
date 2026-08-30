"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { apiKeyPlugin } from "@/lib/auth/api-key-plugin";
import { getQueryClient } from "@/lib/query-client";
import { AuthProvider } from "./auth/auth-provider";
import { Toaster } from "./ui/sonner";

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const queryClient = getQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider
        authClient={authClient}
        // Email/password + GitHub OAuth. The server has no email sender, so
        // forgot/reset-password stays hidden (there's no way to send the
        // reset email); sign-up and email verification-free sign-in work.
        emailAndPassword={{ enabled: true, forgotPassword: false }}
        socialProviders={["github"]}
        navigate={({ to, replace }) => (replace ? router.replace(to) : router.push(to))}
        plugins={[apiKeyPlugin()]}
        Link={Link}
      >
        {children}

        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}
