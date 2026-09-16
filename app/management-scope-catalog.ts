export type ManagementScopeCatalogEntry = {
  scope: string;
  authorityDomain: "site_management" | "release" | "diagnostics";
  siteFullControl: boolean;
  mutation: boolean;
  auditClass: "read" | "management_mutation" | "release" | "diagnostic";
  extraCapability?: string;
};

export const SITE_FULL_CONTROL_MANAGEMENT_PROJECTION_VERSION = "wenmai.site-full-control-management-projection/v5" as const;
export const SITE_FULL_CONTROL_V4_MANAGEMENT_PROJECTION_VERSION = "wenmai.site-full-control-management-projection/v4" as const;

// This is the single authority catalog. New management scopes are denied to a
// site.full_control session until they have deliberately been classified here.
export const MANAGEMENT_SCOPE_CATALOG = [
  { scope: "management.read", authorityDomain: "site_management", siteFullControl: true, mutation: false, auditClass: "read" },
  { scope: "editorial.write", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation" },
  { scope: "identity.decide", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation" },
  { scope: "workspace.branch.write", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation" },
  { scope: "workspace.revision.commit", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation" },
  { scope: "workspace.merge.apply", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation" },
  { scope: "capability.override", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation", extraCapability: "capability_override" },
  { scope: "lifecycle.write", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation" },
  { scope: "release.approve", authorityDomain: "release", siteFullControl: true, mutation: true, auditClass: "release", extraCapability: "release_approval" },
  { scope: "release.record", authorityDomain: "release", siteFullControl: true, mutation: true, auditClass: "release", extraCapability: "release_record" },
  { scope: "rule.adopt", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation" },
  { scope: "package.write", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation" },
  { scope: "package.patch.decide", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation" },
  { scope: "token.issue", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation", extraCapability: "site_key_issue" },
  { scope: "token.revoke", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation", extraCapability: "site_key_revoke" },
  { scope: "task.manage", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation" },
  { scope: "runner.manage", authorityDomain: "site_management", siteFullControl: true, mutation: true, auditClass: "management_mutation" },
  { scope: "admin.diagnostics", authorityDomain: "diagnostics", siteFullControl: true, mutation: true, auditClass: "diagnostic", extraCapability: "diagnostics" },
] as const satisfies readonly ManagementScopeCatalogEntry[];

// Historical v4 exchange Keys are immutable. Keep their signed projection
// separate from the live catalog so a later v5 classification change cannot
// silently widen them or make an otherwise valid v4 Key impossible to revoke.
export const SITE_FULL_CONTROL_V4_MANAGEMENT_SCOPES = [
  "management.read",
  "editorial.write",
  "identity.decide",
  "workspace.branch.write",
  "workspace.revision.commit",
  "workspace.merge.apply",
  "capability.override",
  "lifecycle.write",
  "release.approve",
  "release.record",
  "rule.adopt",
  "package.write",
  "package.patch.decide",
  "token.issue",
  "token.revoke",
  "task.manage",
  "runner.manage",
  "admin.diagnostics",
] as const;

export const MANAGEMENT_SCOPES = MANAGEMENT_SCOPE_CATALOG.map((entry) => entry.scope);
export type ManagementScope = (typeof MANAGEMENT_SCOPE_CATALOG)[number]["scope"];

export function siteFullControlManagementScopes() {
  return MANAGEMENT_SCOPE_CATALOG
    .filter((entry) => entry.siteFullControl)
    .map((entry) => entry.scope);
}

export function canonicalSiteFullControlManagementProjection() {
  return {
    managementProjectionVersion: SITE_FULL_CONTROL_MANAGEMENT_PROJECTION_VERSION,
    managementScopes: siteFullControlManagementScopes(),
  };
}

export function canonicalSiteFullControlV4ManagementProjection() {
  return {
    managementProjectionVersion: SITE_FULL_CONTROL_V4_MANAGEMENT_PROJECTION_VERSION,
    managementScopes: [...SITE_FULL_CONTROL_V4_MANAGEMENT_SCOPES],
  };
}
