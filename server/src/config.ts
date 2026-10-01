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
}).superRefine((value,ctx) => {
  if (value.NODE_ENV==='production' && !value.APP_ORIGIN)
    ctx.addIssue({code:'custom',path:['APP_ORIGIN'],message:'APP_ORIGIN is required in production.'});
  if (value.NODE_ENV==='production' && !/^(?:[A-Za-z]:[\\/]|\/)/.test(value.DATA_DIR))
    ctx.addIssue({code:'custom',path:['DATA_DIR'],message:'DATA_DIR must be absolute in production.'});
  if (value.STORAGE_DRIVER==='s3' && (!value.S3_BUCKET || !value.AWS_REGION))
    ctx.addIssue({code:'custom',path:['S3_BUCKET'],message:'S3_BUCKET and AWS_REGION are required for S3 storage.'});
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error('Invalid server configuration: ' + result.error.issues.map(i => i.path.join('.')).join(', '));
  return result.data;
}
