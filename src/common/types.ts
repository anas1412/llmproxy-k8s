import type { KubernetesObject } from '@kubernetes/client-node';

export const GROUP = 'llmproxy.llmproxy.io';
export const VERSION = 'v1alpha1';

// ---- Channel CRD -----------------------------------------------------------

export interface ChannelSpec {
  /** Upstream API endpoint, e.g. https://api.openai.com */
  baseURL: string;
  /** Provider type — 'openai' covers all OpenAI-compatible providers */
  type: 'openai' | 'anthropic';
  /** Secret in the operator namespace holding the real upstream API key */
  keySecretRef: {
    name: string;
    /** Key within the Secret, defaults to "apiKey" */
    key?: string;
  };
  /** Channel selection priority (higher = more traffic). Default 10. */
  priority?: number;
  /** Enabled | Disabled. Default Enabled. */
  status?: 'Enabled' | 'Disabled';
  /** Models this channel is allowed to serve. Empty/absent = all models. */
  models?: string[];
  /** Optional outbound proxy URL for this channel */
  proxyURL?: string;
  /** Skip upstream TLS certificate verification */
  skipTLSVerify?: boolean;
  /** Model name rewrite rules: requestModel → upstreamModel */
  modelMapping?: Record<string, string>;
  /** Free-form adapter-specific configuration */
  config?: Record<string, unknown>;
}

export interface ChannelStatus {
  conditions?: KubernetesCondition[];
  ready?: boolean;
  message?: string;
}

export interface Channel extends KubernetesObject {
  spec: ChannelSpec;
  status?: ChannelStatus;
}

// ---- ProxyKey CRD ----------------------------------------------------------

export interface ProxyKeySpec {
  /** Name of the Group CR in the operator namespace (tenant definition) */
  groupRef: string;
  /** Enabled | Disabled. Default Enabled. */
  status?: 'Enabled' | 'Disabled';
  /** Model allowlist — must be a subset of the group channels' models (if set) */
  models?: string[];
  /** Lifetime cost quota. 0 = unlimited. */
  quota?: number;
  /** Period cost quota. 0 = unlimited. */
  periodQuota?: number;
  /** Quota reset period. Default monthly. */
  periodType?: 'daily' | 'weekly' | 'monthly';
  /** Allowed client IP CIDRs. Empty = all IPs allowed. */
  subnets?: string[];
}

export interface ProxyKeyStatus {
  conditions?: KubernetesCondition[];
  ready?: boolean;
  message?: string;
  /** SHA-256 hex of the virtual key */
  keyHash?: string;
  /** Name of the tenant Secret holding the raw key */
  secretName?: string;
  /** Tracked cost usage (updated by relay) */
  usedAmount?: number;
  /** Tracked request count (updated by relay) */
  requestCount?: number;
}

export interface ProxyKey extends KubernetesObject {
  spec: ProxyKeySpec;
  status?: ProxyKeyStatus;
}

// ---- Standard Kubernetes Condition -----------------------------------------

export interface KubernetesCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason: string;
  message: string;
  lastTransitionTime: string;
  observedGeneration?: number;
}

// ---- Plural names for the CustomObjectsApi ----------------------------------

export const CHANNEL_PLURAL = 'channels';
export const PROXYKEY_PLURAL = 'proxykeys';
export const GROUP_PLURAL = 'groups';

// ---- Group CRD -------------------------------------------------------------

export interface GroupSpec {
  /** Enabled | Disabled. Default Enabled. */
  status?: 'Enabled' | 'Disabled';
  /** Channel names this group is allowed to route through */
  channelRefs: string[];
  /** Multiplier applied to per-key RPM limits. Default 1.0. */
  rpmRatio?: number;
  /** Multiplier applied to per-key TPM limits. Default 1.0. */
  tpmRatio?: number;
}

export interface GroupStatus {
  conditions?: KubernetesCondition[];
  ready?: boolean;
  message?: string;
}

export interface Group extends KubernetesObject {
  spec: GroupSpec;
  status?: GroupStatus;
}

// ---- Registry types --------------------------------------------------------

/** A route in the in-memory registry — maps a hashed virtual key to a group */
export interface Route {
  keyHash: string;
  groupName: string;
  namespace: string;
  proxyKeyName: string;
  models?: string[];
}

/** A channel entry in the registry — the CRD + resolved upstream key */
export interface ChannelEntry {
  channel: Channel;
  upstreamKey?: string;
}

/** A group entry in the registry — the CRD with resolved state */
export interface GroupEntry {
  group: Group;
}
