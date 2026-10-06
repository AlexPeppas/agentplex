export type PlexPhase = 'idle' | 'planning' | 'awaiting-approval' | 'waiting-for-approval' | 'running' | 'summarizing' | 'interrupted' | 'error';

export interface PlexPermissionEvent {
  requestId: string;
  status: 'requested' | 'completed';
  kind?: string;
  toolName?: string;
  description?: string;
  resource?: string;
  command?: string;
}

export interface PlexPermission extends Omit<PlexPermissionEvent, 'status'> {
  status: 'pending' | 'resolved' | 'interrupted';
  requestedAt: number;
  decision?: { value: PlexPermissionDecision; status: 'queued' | 'delivering' | 'accepted' | 'failed'; error?: string };
}

export type PlexPermissionDecision = 'approve-once' | 'reject';
export type PlexPermissionResponder = (requestId: string, decision: PlexPermissionDecision) => Promise<void>;

export interface PlexQuestionRequest {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}
export interface PlexQuestion extends PlexQuestionRequest {
  id: string;
  jobId: string;
  workerId: string;
  status: 'thinking' | 'human' | 'answered' | 'interrupted';
  answer?: string;
  answeredBy?: 'plex' | 'user';
  reason?: string;
}
export type PlexQuestionHandler = (request: PlexQuestionRequest, signal?: AbortSignal) => Promise<{ answer: string; wasFreeform: boolean }>;

export const PLEX_WORKER_TOOLS = ['view', 'glob', 'rg'] as const;
export const PLEX_TOOL_CATALOG = [
  { id: 'view', label: 'Read files', permission: 'read' },
  { id: 'glob', label: 'Find files', permission: 'read' },
  { id: 'rg', label: 'Search contents', permission: 'read' },
  { id: 'create', label: 'Create files', permission: 'write' },
  { id: 'edit', label: 'Edit files', permission: 'write' },
  { id: 'powershell', label: 'Run PowerShell commands (full local user privileges)', permission: 'shell' },
] as const;
export type PlexTool = typeof PLEX_TOOL_CATALOG[number]['id'];

export function validatePlexTools(value: unknown): PlexTool[] {
  if (!Array.isArray(value) || value.length > PLEX_TOOL_CATALOG.length ||
    value.some(tool => !PLEX_TOOL_CATALOG.some(entry => entry.id === tool)) || new Set(value).size !== value.length) {
    throw new Error('Invalid or unsupported Copilot tool selection');
  }
  return PLEX_TOOL_CATALOG.filter(tool => value.includes(tool.id)).map(tool => tool.id);
}

export interface PlexAgentBlueprint {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tools: PlexTool[];
  model?: string;
}

export function validatePlexModel(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)) {
    throw new Error('Invalid Copilot model ID');
  }
  return value;
}

export interface PlexModel { id: string; name: string; enabled: boolean }
export interface PlexActivity {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'status';
  text: string;
}
export interface PlexTranscript { entries: PlexActivity[]; truncated: boolean; started: boolean }

export interface PlexSquadBlueprint {
  id: string;
  name: string;
  revision: number;
  agents: PlexAgentBlueprint[];
}

export interface PlexMount {
  conversationId: string;
  rootJobId: string;
  cwd: string;
  blueprint: PlexSquadBlueprint;
}

export interface PlexConversation extends PlexMount {
  title: string;
  createdAt: number;
}

export interface PlexWorkspace {
  revision: number;
  conversations: (PlexConversation & { phase: PlexPhase })[];
  blueprints: PlexSquadBlueprint[];
  states: Record<string, PlexState>;
  migrationNotes: string[];
}

export interface PlexMessage {
  role: 'user' | 'plex' | 'system';
  text: string;
  kind?: 'plan';
}

export interface PlexAgent {
  provider: 'copilot';
  id: string;
  name: string;
  description?: string;
  tools?: PlexTool[];
  model?: string;
  instructions?: string;
  conversationId?: string;
  rootJobId?: string;
  blueprintAgentId?: string;
  cwd: string;
  squadId: string;
  squadName: string;
  status: 'idle' | 'running' | 'waiting-for-approval';
}

export interface PlexTaskSpec {
  id: string;
  title: string;
  instructions: string;
  acceptance: string;
  dependsOn: string[];
  agentId: string | null;
  memberIndex: number | null;
}

export interface PlexPlan {
  message: string;
  squadId: string | null;
  tasks: PlexTaskSpec[];
}

export interface PlexResult {
  summary: string;
  evidence: string[];
  limitations: string[];
}

export interface PlexTask extends PlexTaskSpec {
  status: 'pending' | 'queued' | 'running' | 'waiting-for-approval' | 'completed' | 'blocked';
  permissions?: PlexPermission[];
  activity?: PlexActivity[];
  assignedAgentId?: string;
  result?: PlexResult;
  error?: string;
  jobId?: string;
  resultId?: string;
}

export interface PlexWorkerResult extends PlexResult {
  status: 'completed' | 'blocked';
}

export interface PlexJob {
  id: string;
  missionId: string;
  task: PlexTaskSpec;
  workerId: string;
  status: 'queued' | 'running' | 'completed' | 'blocked';
  createdAt: number;
  claimToken?: string;
  leaseUntil?: number;
  resultId?: string;
  permissions?: PlexPermission[];
}

export interface PlexResultItem {
  id: string;
  jobId: string;
  missionId: string;
  workerId: string;
  source: 'worker' | 'broker';
  createdAt: number;
  result: PlexWorkerResult;
}

export interface PlexState {
  version: 2;
  enabled: boolean;
  phase: PlexPhase;
  messages: PlexMessage[];
  agents: PlexAgent[];
  tasks: PlexTask[];
  plan: PlexPlan | null;
  proposedSquad: { name: string; members: { name: string; cwd: string }[] } | null;
  error: string | null;
  missionId: string | null;
  mount?: PlexMount;
  approvalId?: string | null;
  ingressId?: string;
  activity?: PlexActivity[];
  planDecision?: { approvalId: string; status: 'approved' | 'rejected'; taskIds: string[] };
  brainBusy?: boolean;
  steering?: PlexSteering[];
  questions?: PlexQuestion[];
  approvedGoal?: PlexPlan;
}

export interface PlexSteering {
  id: string;
  missionId: string;
  jobId: string;
  workerId: string;
  prompt: string;
  status: 'pending' | 'delivering' | 'accepted' | 'failed';
  providerMessageId?: string;
  error?: string;
}

export const PLEX_IPC = {
  models: 'plex:models',
  transcript: 'plex:transcript',
  workspace: 'plex:workspace',
  createConversation: 'plex:conversation-create',
  saveBlueprint: 'plex:blueprint-save',
  deleteBlueprint: 'plex:blueprint-delete',
  chat: 'plex:chat',
  approve: 'plex:approve',
  cancel: 'plex:cancel',
  permissionDecision: 'plex:permission-decision',
  answerQuestion: 'plex:answer-question',
  changed: 'plex:changed',
} as const;

export interface PlexAPI {
  plexModels(): Promise<PlexModel[]>;
  plexTranscript(conversationId: string, agentId: string): Promise<PlexTranscript>;
  plexWorkspace(): Promise<PlexWorkspace>;
  plexCreateConversation(cwd: string, blueprintId: string, requestId: string): Promise<PlexWorkspace>;
  plexSaveBlueprint(blueprint: PlexSquadBlueprint): Promise<PlexWorkspace>;
  plexDeleteBlueprint(id: string): Promise<PlexWorkspace>;
  plexChat(message: string, conversationId: string, messageId: string): Promise<PlexWorkspace>;
  plexApprove(conversationId: string, approvalId: string): Promise<PlexWorkspace>;
  plexCancel(conversationId: string, approvalId?: string): Promise<PlexWorkspace>;
  plexPermissionDecision(conversationId: string, jobId: string, requestId: string, decision: PlexPermissionDecision): Promise<PlexWorkspace>;
  plexAnswerQuestion(conversationId: string, questionId: string, answer: string): Promise<PlexWorkspace>;
  onPlexChanged(callback: (state: PlexWorkspace) => void): () => void;
}
