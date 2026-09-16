export type AgentPermissionAction = {
  actionId: string;
  routeId?: string;
  route: string;
  wireAction: string;
  method?: string;
  stableCommandId?: boolean;
  cas?: boolean;
};

export type AgentPermission = {
  id?: string;
  scope: string;
  label: string;
  description?: string;
  category?: string;
  risk?: string;
  allowedRoles: Array<"agent" | "administrator" | "super_admin">;
  transport?: "local" | "tailscale" | "local/tailscale" | "local_only";
  localOnly?: boolean;
  delegable: boolean;
  newIssuance?: boolean;
  conflictsWith?: string[];
  actions: AgentPermissionAction[];
};

export type AgentPermissionArticleObject = {
  id: string;
  label?: string;
  branchCount?: number;
  packageCount?: number;
};

export type AgentPermissionPreset = {
  id?: string;
  presetId?: string;
  label?: string;
  description?: string;
  scopes: string[];
};

export type AgentPermissionCatalog = {
  schemaVersion: string;
  catalogVersion: string;
  catalogSha256?: string;
  permissions?: AgentPermission[];
  scopes?: AgentPermission[];
  presets: AgentPermissionPreset[];
  articleObjectCount?: number;
  articleObjects?: AgentPermissionArticleObject[];
  humanCeremonies?: string[];
};
