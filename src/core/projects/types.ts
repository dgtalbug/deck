export interface ProjectInfo {
  name: string;
  path: string;
  createdAt: string;
}

export interface ProjectSummary extends ProjectInfo {
  activeCount: number;
  doneCount: number;
  lastActivity: string;
}
