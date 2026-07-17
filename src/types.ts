import type { KubernetesObject } from '@kubernetes/client-node';

export const GROUP = 'llmproxy.llmproxy.io';
export const VERSION = 'v1alpha1';

/**
 * Channel — an upstream LLM provider. Lives ONLY in the operator namespace,
 * because it references the real provider API key secret.
 */
export interface Channel extends KubernetesObject {
  spec: {
    /** e.g. https://api.anthropic.com or https://api.openai.com */
    baseURL: string;
    /** 'openai' | 'anthropic' — controls which auth header is set upstream */
    type: 'openai' | 'anthropic';
    /** Secret in the operator namespace holding the real key */
    keySecretRef: { name: string; key?: string }; // key defaults to "apiKey"
    /** Models this channel is allowed to serve. Empty = allow all. */
    models?: string[];
  };
  status?: { ready?: boolean; message?: string };
}

/**
 * ProxyKey — created by tenants in their own namespace.
 * The operator mints a virtual key, writes it to a Secret next to the CR,
 * and stores only the SHA-256 hash in status.
 */
export interface ProxyKey extends KubernetesObject {
  spec: {
    /** Name of a Channel in the operator namespace */
    channelRef: string;
    /** Optional model allowlist, must be a subset of the channel's models */
    models?: string[];
  };
  status?: {
    ready?: boolean;
    message?: string;
    /** sha256 hex of the virtual key — the key itself is only in the Secret */
    keyHash?: string;
    secretName?: string;
  };
}

export const CHANNEL_PLURAL = 'channels';
export const PROXYKEY_PLURAL = 'proxykeys';
