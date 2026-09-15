import { ProviderDispatchError } from "./provider-failures";

export type ProviderInteractionPolicy = "standard" | "consultation-only";

export class ProviderCapabilityUnavailableError extends ProviderDispatchError {
  readonly code = "CAPABILITY_UNAVAILABLE";

  constructor(readonly capability: string, message: string) {
    super({ message, failureClass: "parked_access", terminalConfirmed: true });
    this.name = "ProviderCapabilityUnavailableError";
  }
}

export function assertProviderInteractionPolicy(policy: ProviderInteractionPolicy | undefined) {
  if (policy !== undefined && policy !== "standard" && policy !== "consultation-only") {
    throw new ProviderCapabilityUnavailableError("policy", "The requested provider policy is unavailable.");
  }
}

export function assertProviderForkPolicy(policy: ProviderInteractionPolicy | undefined) {
  assertProviderInteractionPolicy(policy);
  if (policy === "consultation-only") {
    throw new ProviderCapabilityUnavailableError("fork", "Native forks cannot preserve the information-only consultation policy.");
  }
}

export const CONSULTATION_PERMISSION_PROFILE = "concierge-consultation";

export function codexConsultationConfig(effectiveConfig: unknown): Record<string, unknown> {
  if (!effectiveConfig || typeof effectiveConfig !== "object" || Array.isArray(effectiveConfig)) {
    throw new ProviderCapabilityUnavailableError("consultation", "Codex effective tool configuration could not be established.");
  }
  const servers = (effectiveConfig as Record<string, unknown>).mcp_servers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new ProviderCapabilityUnavailableError("consultation", "Codex effective MCP configuration could not be established.");
  }
  const config: Record<string, unknown> = {
    // Codex splits override paths on dots without interpreting quoted segments.
    mcp_servers: Object.fromEntries(Object.keys(servers ?? {}).map(name => [name, { enabled: false }])),
    web_search: "disabled",
    project_doc_max_bytes: 0,
    [`permissions.${CONSULTATION_PERMISSION_PROFILE}.filesystem`]: { ":root": "deny" },
    [`permissions.${CONSULTATION_PERMISSION_PROFILE}.network.enabled`]: false,
    shell_environment_policy: { inherit: "none", set: {} },
    "features.skip_host_skill_discovery": true,
    "tools.update_plan.enabled": false,
    "tools.experimental_request_user_input.enabled": false,
  };
  for (const feature of [
    "apps", "plugins", "browser_use", "browser_use_external", "computer_use", "image_generation",
    "shell_tool", "unified_exec", "view_image", "multi_agent", "multi_agent_v2", "collab",
    "code_mode", "code_mode_host", "js_repl", "apply_patch_freeform", "memory_tool", "memories",
    "goals", "send_async_message", "request_permissions", "request_permissions_tool", "tool_search",
    "skill_search", "skill_mcp_dependency_install", "hooks", "codex_hooks", "plugin_hooks",
    "tool_suggest", "recommended_plugins", "deferred_executor", "token_budget", "sleep_tool",
    "current_time_reminder", "default_mode_request_user_input",
  ]) config[`features.${feature}`] = false;
  return config;
}

export function claudeConsultationArgs(): string[] {
  return [
    "--safe-mode", "--restricted",
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disallowedTools", "mcp__*", "--tools", "",
  ];
}
