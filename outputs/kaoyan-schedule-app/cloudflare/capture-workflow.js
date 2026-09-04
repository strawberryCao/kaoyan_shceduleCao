import { WorkflowEntrypoint } from 'cloudflare:workers';
import { detectCaptureBatch, saveDetectedCaptureBatch } from './capture-batches.js';

export class CaptureWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const jobId = event?.payload?.jobId;
    const forceRewrite = event?.payload?.forceRewrite === true;
    const detection = await step.do(
      'recognize complete question regions',
      {
        retries: {
          limit: 1,
          delay: '10 seconds',
          backoff: 'exponential',
        },
        timeout: '8 minutes',
      },
      () => detectCaptureBatch(this.env, jobId, { forceRewrite }),
    );
    if (!detection?.ok || detection.skipSave) return detection;
    return step.do(
      'crop and atomically save results',
      {
        retries: {
          limit: 2,
          delay: '10 seconds',
          backoff: 'exponential',
        },
        timeout: '5 minutes',
      },
      () => saveDetectedCaptureBatch(this.env, detection),
    );
  }
}
