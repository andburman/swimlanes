export interface Node {
  id: string;
  rev: number;
  parent: string | null;
  project: string;
  summary: string;
  resolved: boolean;
  state: unknown;
  properties: Record<string, unknown>;
  context_links: string[];
  evidence: Evidence[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Evidence {
  type: string;
  ref: string;
  agent: string;
  timestamp: string;
}

export interface Edge {
  id: string;
  from_node: string;
  to_node: string;
  type: string;
  created_at: string;
}

export interface Event {
  id: string;
  node_id: string;
  agent: string;
  action: string;
  changes: FieldChange[];
  timestamp: string;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface NodeRow {
  id: string;
  rev: number;
  parent: string | null;
  project: string;
  summary: string;
  resolved: number;
  state: string | null;
  properties: string;
  context_links: string;
  evidence: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}
