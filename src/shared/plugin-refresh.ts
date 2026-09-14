export type PluginSurface = 'core' | 'desktop' | 'plugins';
export interface PluginToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}
export interface PluginPublication {
  surface: PluginSurface;
  schemaId: string;
  connectorName: string;
  tools: PluginToolSchema[];
}
export interface PluginRefreshRequest extends PluginPublication {
  id: string;
  appId: string | null;
  /** A prior refresh click was already claimed. Inspect only; never claim or click again. */
  verificationOnly?: boolean;
}
