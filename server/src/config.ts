import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z.string().url(),
  DATA_DIR: z.string().min(1).default('data'),
  STORAGE_DRIVER: z.enum(['filesystem','s3']).default('filesystem'),
  EMBEDDED_WORKER: z.enum(['true','false']).default('false').transform(value => value === 'true'),
  S3_BUCKET: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).optional(),
  APP_ORIGIN: z.string().url().optional(),
  DEMO_MODE: z.enum(['true','false']).default('false').transform(value=>value==='true'),
  DEMO_CSV_ROWS: z.coerce.number().int().positive().default(200),
  DEMO_CSV_BYTES: z.coerce.number().int().positive().default(256*1024),
  DEMO_EVIDENCE_BYTES: z.coerce.number().int().positive().default(2*1024*1024),
  DEMO_EXPORT_BYTES: z.coerce.number().int().positive().default(2*1024*1024),
  DEMO_STORAGE_BYTES: z.coerce.number().int().positive().default(50*1024*1024),
  DEMO_TRANSFER_BYTES: z.coerce.number().int().positive().default(1024*1024*1024),
  DEMO_DATABASE_BYTES: z.coerce.number().int().positive().default(200*1024*1024),
  DEMO_JOB_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(10),
  DEMO_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(300),
  DEMO_ACCOUNT_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(120),
  DEMO_LOGINS_PER_MINUTE: z.coerce.number().int().positive().default(20),
  DEMO_MANAGER_PASSWORD: z.string().min(12).optional(),
  DEMO_STAFF_PASSWORD: z.string().min(12).optional(),
  DEMO_VIEWER_PASSWORD: z.string().min(12).optional(),
}).superRefine((value,ctx) => {
  if (value.NODE_ENV==='production' && !value.APP_ORIGIN)
    ctx.addIssue({code:'custom',path:['APP_ORIGIN'],message:'APP_ORIGIN is required in production.'});
  if (value.NODE_ENV==='production' && !/^(?:[A-Za-z]:[\\/]|\/)/.test(value.DATA_DIR))
    ctx.addIssue({code:'custom',path:['DATA_DIR'],message:'DATA_DIR must be absolute in production.'});
  if (value.STORAGE_DRIVER==='s3' && (!value.S3_BUCKET || !value.AWS_REGION))
    ctx.addIssue({code:'custom',path:['S3_BUCKET'],message:'S3_BUCKET and AWS_REGION are required for S3 storage.'});
  if(value.DEMO_MODE && (!value.DEMO_MANAGER_PASSWORD || !value.DEMO_STAFF_PASSWORD || !value.DEMO_VIEWER_PASSWORD))
    ctx.addIssue({code:'custom',path:['DEMO_MODE'],message:'Explicit public demo passwords are required.'});
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error('Invalid server configuration: ' + result.error.issues.map(i => i.path.join('.')).join(', '));
  return result.data;
}
