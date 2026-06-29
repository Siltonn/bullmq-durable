/// <reference types="vite/client" />

import type { CockpitConfig } from "@shared/dto"

declare global {
  interface Window {
    /** Injected by the server into the HTML shell (see server/client.ts). */
    __BULLMQ_COCKPIT__?: Partial<CockpitConfig>
  }
}

export {}
