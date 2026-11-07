import type { FacetApi } from '../shared/api';

declare global {
  interface Window {
    facet: FacetApi;
  }
}
export {};
