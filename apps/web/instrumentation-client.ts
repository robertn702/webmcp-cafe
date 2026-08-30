// Client initialization that must run before React hydration: site tools first,
// then Sentry error monitoring.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

import { env } from "@/env";
import { registerSiteTools } from "@/lib/site-tools";

registerSiteTools();

Sentry.init({
  dsn: env.NEXT_PUBLIC_SENTRY_DSN,

  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: false, response: false },
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: false,
    frameContextLines: 0,
  },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
