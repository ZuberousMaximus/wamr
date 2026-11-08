import { apiClient } from './api.client';

export interface GroupRecapConfig {
  enabled: boolean;
  groupJid: string | null;
  groupName: string | null;
  brief: string;
  windowStart: string;
  windowEnd: string;
}

export interface GroupRecapState {
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: string | null;
}

export interface GroupRecapResponse {
  config: GroupRecapConfig;
  state: GroupRecapState;
  llmEnabled: boolean;
  llmDisabledReason: string | null;
  serverTimeZone: string;
}

export interface RecapDraft {
  kind: 'recap' | 'quip' | 'template' | 'skip';
  text: string | null;
  requestCount: number;
}

export interface WhatsAppGroup {
  id: string;
  name: string;
  size: number;
}

export function getGroupRecap(): Promise<GroupRecapResponse> {
  return apiClient.get('/api/group-recap');
}

export function saveGroupRecap(
  config: GroupRecapConfig
): Promise<{ config: GroupRecapConfig; state: GroupRecapState }> {
  return apiClient.put('/api/group-recap', config);
}

export function getWhatsAppGroups(): Promise<{ groups: WhatsAppGroup[] }> {
  return apiClient.get('/api/group-recap/groups');
}

export function previewGroupRecap(brief?: string): Promise<RecapDraft> {
  return apiClient.post('/api/group-recap/preview', brief === undefined ? {} : { brief });
}

export function sendGroupRecapNow(): Promise<RecapDraft & { state: GroupRecapState }> {
  return apiClient.post('/api/group-recap/send-now', {});
}
