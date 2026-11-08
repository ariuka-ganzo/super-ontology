import type { OntologyApi } from '../shared/api';

declare global {
  interface Window {
    ontology: OntologyApi;
  }
}
export {};
