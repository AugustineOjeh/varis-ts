export type ServiceType =
  | "data"
  | "content"
  | "tool"
  | "skill"
  | "compute"
  | "memory"
  | "storage"
  | "model"
  | "messaging";

export type ServiceStatus = "draft" | "published" | "disabled";

export interface ServiceDefinition {
  /** Unique within your owner, and permanent. Lowercase words joined by hyphens. */
  slug: string;
  name: string;
  /** At least 20 characters. Agents read this to decide whether to call you. */
  description: string;
  service_type: ServiceType;
  /** At least one category slug. */
  categories: string[];
  /** Must be HTTPS and publicly reachable. */
  endpoint_url: string;
  /** Price per request, in US cents. Zero makes the service free. */
  price_cents: number;
  /** Recorded, not resolved. Defaults to "1.0.0". */
  version?: string;
  /** Defaults to "published". */
  status?: ServiceStatus;
}
