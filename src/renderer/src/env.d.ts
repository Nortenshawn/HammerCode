/// <reference types="vite/client" />

import type { HammerCodeApi } from "../../shared/contracts";

declare global {
  interface Window {
    hammerCode: HammerCodeApi;
  }
}

export {};
