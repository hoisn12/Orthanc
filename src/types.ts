import type Database from 'better-sqlite3';

// ── Session ─────────────────────────────────────────────────

export interface SessionData {
  pid: number;
  sessionId: string;
  activeSessionId?: string;
  cwd: string;
  startedAt: number;
  kind?: string;
  name: string;
  entrypoint?: string;
}

export interface SessionInfo extends SessionData {
  alive: boolean;
  uptime: number;
}

// ── Token / Usage ───────────────────────────────────────────

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface UsageRecord extends TokenCounts {
  messageId: string | null;
  model: string;
  timestamp: string;
}

export interface TokenRecord extends TokenCounts {
  id: string;
  sessionId: string;
  sessionFile: string;
  timestamp: string;
  model: string;
  cwd: string;
  startedAt: string;
  lastActivity: string;
}

export interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}

// ── Events ──────────────────────────────────────────────────

export interface EventInput {
  type: string;
  payload?: Record<string, unknown>;
  sessionId?: string | null;
  pid?: number | null;
  source?: string;
}

export interface EventEntry {
  id: string;
  timestamp: string;
  type: string;
  sessionId: string | null;
  pid: number | null;
  payload: Record<string, unknown>;
}

// ── Hooks / Config ──────────────────────────────────────────

export interface HookEntry {
  type: string;
  command?: string;
  url?: string;
  timeout?: number;
  statusMessage?: string;
  _marker?: string;
}

export interface HookRule {
  matcher: string;
  hooks: HookEntry[];
  source?: string;
}

export interface MonitorStatus {
  hooks: boolean;
  otel: boolean;
  statusline: boolean;
}

export interface InstallOptions {
  hooks?: boolean;
  otel?: boolean;
  statusline?: boolean;
}

export interface InstallResult {
  installed: number;
  path: string;
  otel?: boolean;
  statusline?: boolean;
}

export interface UninstallResult {
  removed: number;
  path: string;
}

// ── Metrics ─────────────────────────────────────────────────

export interface ApiCallRecord {
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  timestamp: number;
}

export interface ToolExecutionRecord {
  toolName: string;
  durationMs: number;
  success: boolean;
  timestamp: number;
}

export interface ApiErrorRecord {
  model: string;
  errorType: string;
  statusCode: number;
  timestamp: number;
}

export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  count: number;
}

export interface ToolStats {
  count: number;
  avg: number;
  p95: number;
  errorRate: number;
}

export interface ModelBreakdown {
  calls: number;
  totalLatency: number;
  totalCost: number;
  totalTokens: number;
  avgLatency: number;
}

export interface MetricsSummary {
  latency: LatencyStats;
  costTimeline: { timestamp: number; cost: number }[];
  toolStats: Record<string, ToolStats>;
  errorRate: { total: number; byType: Record<string, number> };
  modelBreakdown: Record<string, ModelBreakdown>;
}

// ── Project Config ──────────────────────────────────────────

export interface SkillInfo {
  name: string;
  description: string;
  active: boolean;
  hasContent: boolean;
  filePath: string;
  symlink: boolean;
  userInvocable: boolean;
  source?: string;
}

export interface AgentInfo {
  name: string;
  filePath: string;
  source?: string;
}

export interface RuleInfo {
  name: string;
  filePath: string;
  glob?: string;
  source?: string;
}

export interface ClaudeMdFile {
  path: string;
  dir: string;
  level: string;
  preview: string;
}

export interface SettingsLayer {
  path: string;
  label: string;
  isGlobal: boolean;
  settings: { exists: boolean; keys: string[] };
  localSettings: { exists: boolean; keys: string[] };
}

export interface McpServer {
  name: string;
  source: string;
  command?: string;
  url?: string;
}

export interface PermissionsInfo {
  coreTools: string[];
  mcpTools: string[];
  webAccess: string[];
  skills: string[];
}

export interface ProjectConfig {
  skills: SkillInfo[];
  agents: AgentInfo[];
  rules: RuleInfo[];
  hooks: Record<string, HookRule[]>;
  env: Record<string, string>;
  sources: string[];
  permissions: PermissionsInfo;
  claudeMdFiles: ClaudeMdFile[];
  settingsLayers: SettingsLayer[];
  mcpServers: McpServer[];
  profiles?: { name: string; filePath: string; source: string }[];
  plugins?: { name: string; path: string; source: string }[];
  projectRoot?: string;
  projectName?: string;
  provider?: string;
  loadedInstructions?: { path: string; memoryType: string; loadReason: string; timestamp: string }[];
}

// ── Database ────────────────────────────────────────────────

export type DbInstance = Database.Database;
