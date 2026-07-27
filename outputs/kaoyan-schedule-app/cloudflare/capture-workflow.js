import { WorkflowEntrypoint } from 'cloudflare:workers';
import { processCaptureBatch } from './capture-batches.js';

export class CaptureWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const jobId = event?.payload?.jobId;
    return step.do(
      'recognize crop and atomically save results',
      {
        retries: {
          limit: 3,
          delay: '30 seconds',
          backoff: 'exponential',
        },
        timeout: '10 minutes',
      },
      () => processCaptureBatch(this.env, jobId),
    );
  }
}
