// Paid or slow work that must survive a restart: every Seedance task is written down the moment it is
// submitted (task id, shot, parameters), with whether it has been charged. After a restart, unfinished
// tasks are polled again by task id and downloaded; nothing is ever submitted or charged twice.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

export type JobStatus = 'submitted' | 'done' | 'failed' | 'discarded';
export interface Job {
  /** Provider task id (Seedance) */
  taskId: string;
  kind: 'seedance';
  session: string;
  shotId: string;
  /** Content hash of the shot inputs; the clip lands at clips/<inputHash>.mp4 in the session folder. */
  inputHash: string;
  outPath: string;
  params: { prompt: string; seconds: number; aspect: string; audio: boolean; model: string };
  item: string;
  status: JobStatus;
  /** Booked in the ledger already. */
  charged: boolean;
  /** The user stopped the turn: the result is not attached to the shot, but the charge still counts. */
  discard?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const file = join(config.dataDir, 'jobs.json');
let jobs: Job[] = (() => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { jobs: Job[] }).jobs : [];
  } catch {
    return [];
  }
})();

function save() {
  // Finished jobs are kept a week for the trajectory and the reconciliation log, then dropped.
  const cutoff = Date.now() - 7 * 86_400_000;
  jobs = jobs.filter((j) => j.status === 'submitted' || Date.parse(j.updatedAt) > cutoff);
  writeFileSync(file + '.tmp', JSON.stringify({ jobs }, null, 1));
  renameSync(file + '.tmp', file);
}

export const jobStore = {
  add(j: Omit<Job, 'createdAt' | 'updatedAt' | 'status' | 'charged'>): Job {
    const now = new Date().toISOString();
    const job: Job = { ...j, status: 'submitted', charged: false, createdAt: now, updatedAt: now };
    jobs.push(job);
    save();
    return job;
  },
  update(taskId: string, patch: Partial<Job>) {
    const j = jobs.find((x) => x.taskId === taskId);
    if (!j) return;
    Object.assign(j, patch, { updatedAt: new Date().toISOString() });
    save();
  },
  get: (taskId: string) => jobs.find((x) => x.taskId === taskId),
  open: () => jobs.filter((j) => j.status === 'submitted'),
  forSession: (session: string) => jobs.filter((j) => j.session === session),
};
