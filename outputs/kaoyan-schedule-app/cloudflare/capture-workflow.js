import { WorkflowEntrypoint } from 'cloudflare:workers';
import { processCaptureBatch } from './capture-batches.js';

export class CaptureWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const jobId = event?.payload?.jobId;
    return step.do(
      'recognize crop and atomically save results',
      {
        retries: {
          limit: 1,
          delay: '15 seconds',
          backoff: 'constant',
        },
        timeout: '90 seconds',
      },
      () => processCaptureBatch(this.env, jobId),
    );
  }
}
