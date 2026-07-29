import { WorkflowEntrypoint } from 'cloudflare:workers';
import { processCaptureBatch } from './capture-batches.js';

export class CaptureWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const jobId = event?.payload?.jobId;
    return step.do(
      'recognize crop and atomically save results',
      {
        retries: {
          limit: 2,
          delay: '10 seconds',
          backoff: 'exponential',
        },
        timeout: '3 minutes',
      },
      () => processCaptureBatch(this.env, jobId),
    );
  }
}
