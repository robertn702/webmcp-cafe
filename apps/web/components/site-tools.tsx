"use client";

import { useEffect } from "react";
import { registerSiteTools } from "@/lib/site-tools";

export function SiteTools() {
  useEffect(() => {
    const registration = registerSiteTools();
    return registration.dispose;
  }, []);

  return null;
}
