import { KubeConfig } from '@kubernetes/client-node';
import { ProxyKeyReconciler } from './reconcile.js';
import { startInformers } from './informers.js';
import { startProxy } from './proxy.js';

const kc = new KubeConfig();
kc.loadFromDefault(); // in-cluster SA when deployed, ~/.kube/config for local dev

const reconciler = new ProxyKeyReconciler(kc);
await startInformers(kc, reconciler);
startProxy();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
