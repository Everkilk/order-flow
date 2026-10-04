import { createHash, randomBytes } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Config } from './config.js';
import { withTransaction } from './db.js';
import { withMutation } from './mutations.js';

export type Actor = { id: string; email: string; displayName: string; role: 'MANAGER' | 'STAFF' | 'VIEWER'; warehouses: string[]; mustChangePassword: boolean };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const passwordHash = (value: string) => hash(value, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
const cookieName = 'orderflow_session';
const sessionAge = 8 * 60 * 60 * 1000;

function getCookie(header: string | undefined): string | undefined {
  return header?.split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
}

export function sessionHashFromCookie(header: string | undefined): string | undefined {
  const token=getCookie(header);
  return token && /^[0-9a-f]{64}$/.test(token) ? digest(token) : undefined;
}

function cookieOptions(config: Config) {
  return { httpOnly: true as const, secure: config.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/', maxAge: sessionAge };
}

export function authMiddleware(pool: pg.Pool): RequestHandler {
  return async (req, res, next) => {
    try {
      const tokenHash = sessionHashFromCookie(req.headers.cookie);
      if (!tokenHash) return next();
      const result = await pool.query(`SELECT u.id, u.email, u.display_name, u.role, u.must_change_password,
        coalesce(array_agg(uw.warehouse_id::text) FILTER (WHERE uw.warehouse_id IS NOT NULL), '{}') warehouses
        FROM orderflow.sessions s JOIN orderflow.users u ON u.id=s.user_id
        LEFT JOIN orderflow.user_warehouses uw ON uw.user_id=u.id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active
        GROUP BY u.id`, [tokenHash]);
      if (result.rows[0]) {
        const user = result.rows[0];
        res.locals.actor = { id: String(user.id), email: user.email, displayName: user.display_name,
          role: user.role, warehouses: user.warehouses, mustChangePassword: user.must_change_password } satisfies Actor;
      }
      next();
    } catch (error) { next(error); }
  };
}

export const requireActor: RequestHandler = (_req, res, next) => {
  const actor = res.locals.actor as Actor | undefined;
  if (!actor) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in first.'));
  if (actor.mustChangePassword) return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your password before continuing.'));
  next();
};

export function requireRole(...roles: Actor['role'][]): RequestHandler {
  return (_req, res, next) => {
    const actor = res.locals.actor as Actor | undefined;
    if (!actor) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in first.'));
    if (actor.mustChangePassword) return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your password before continuing.'));
    if (!roles.includes(actor.role)) return next(new AppError(403, 'FORBIDDEN', 'This action is not permitted.'));
    next();
  };
}

export function warehouseAllowed(actor: Actor, id: string): boolean {
  return actor.role === 'MANAGER' || actor.warehouses.includes(id);
}

const loginInput = z.object({ email: z.email().max(254), password: z.string().min(1).max(1024) }).strict();
const changeInput = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(1024) }).strict();
const userInput = z.object({ email: z.email().max(254), displayName: z.string().trim().min(1).max(160),
  role: z.enum(['MANAGER','STAFF','VIEWER']), password: z.string().min(12).max(1024) }).strict();
const userUpdate = z.object({ displayName: z.string().trim().min(1).max(160).optional(), role: z.enum(['MANAGER','STAFF','VIEWER']).optional(), active: z.boolean().optional() }).strict();
const idInput = z.string().regex(/^[1-9]\d*$/);
const usersFilter=z.object({cursor:idInput.optional(),role:z.enum(['MANAGER','STAFF','VIEWER']).optional(),
  active:z.enum(['true','false']).optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();

export function authRoutes(pool: pg.Pool, config: Config): Router {
  const router = Router();
  const failures = new Map<string, { count: number; until: number }>();
  router.post('/auth/login', async (req, res) => {
    const input = loginInput.parse(req.body);
    const failureKey = `${req.ip || 'unknown'}:${input.email.toLowerCase()}`;
    const state = failures.get(failureKey);
    if (state && state.count >= 5 && state.until > Date.now()) throw new AppError(429, 'LOGIN_LIMIT', 'Try signing in later.');
    const result = await pool.query('SELECT id,email,display_name,password_hash,role,active,must_change_password FROM orderflow.users WHERE lower(email)=lower($1)', [input.email]);
    const user = result.rows[0];
    let valid = false;
    if (user?.active) {
      try { valid = await verify(user.password_hash, input.password); } catch { valid = false; }
    }
    if (!valid) {
      failures.delete(failureKey);
      if (failures.size >= 10_000) failures.delete(failures.keys().next().value!);
      failures.set(failureKey, { count: state && state.until > Date.now() ? state.count + 1 : 1,
        until: Date.now() + 10 * 60_000 });
      throw new AppError(401, 'INVALID_LOGIN', 'Incorrect email or password.');
    }
    failures.delete(failureKey);
    const token = randomBytes(32).toString('hex');
    await pool.query("INSERT INTO orderflow.sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '8 hours')", [user.id, digest(token)]);
    res.cookie(cookieName, token, cookieOptions(config));
    res.json({ user: { id: String(user.id), email: user.email, displayName: user.display_name, role: user.role, mustChangePassword: user.must_change_password } });
  });
  router.post('/auth/logout', async (req, res) => {
    const token = getCookie(req.headers.cookie);
    if (token) await pool.query('UPDATE orderflow.sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [digest(token)]);
    res.clearCookie(cookieName, cookieOptions(config));
    res.status(204).end();
  });
  router.get('/auth/me', (_req, res) => {
    if (!res.locals.actor) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in first.');
    res.json({ user: res.locals.actor });
  });
  router.post('/auth/change-password', async (req, res) => {
    const input = changeInput.parse(req.body);
    const actor = res.locals.actor as Actor | undefined;
    if (!actor) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in first.');
    const existing = await pool.query('SELECT password_hash FROM orderflow.users WHERE id=$1', [actor.id]);
    if (!await verify(existing.rows[0].password_hash, input.currentPassword)) throw new AppError(422, 'INVALID_PASSWORD', 'Current password is incorrect.');
    const nextHash = await passwordHash(input.newPassword);
    await withTransaction(pool, async client => {
      await client.query('UPDATE orderflow.users SET password_hash=$1,must_change_password=false WHERE id=$2', [nextHash, actor.id]);
      await client.query('UPDATE orderflow.sessions SET revoked_at=now() WHERE user_id=$1', [actor.id]);
      await client.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'PASSWORD_CHANGE','user',$2)", [actor.id,actor.id]);
    });
    res.clearCookie(cookieName, cookieOptions(config));
    res.status(204).end();
  });
  router.post('/users', requireRole('MANAGER'), async (req, res) => {
    const input = userInput.parse(req.body);
    const password = await passwordHash(input.password);
    const actor = res.locals.actor as Actor;
    const id = await withMutation(pool,req,actor,async client => {
      const row = await client.query('INSERT INTO orderflow.users(email,display_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id',
        [input.email, input.displayName, password, input.role]);
      await client.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'USER_CREATE','user',$2)", [actor.id, String(row.rows[0].id)]);
      return String(row.rows[0].id);
    });
    res.status(201).json({ id });
  });
  router.get('/users',requireRole('MANAGER'),async(req,res) => {
    const input=usersFilter.parse(req.query);
    const result=await pool.query(`SELECT id::text,email,display_name AS "displayName",role,active,
      must_change_password AS "mustChangePassword",locale,timezone,created_at AS "createdAt"
      FROM orderflow.users WHERE ($1::bigint IS NULL OR id<$1)
      AND ($2::text IS NULL OR role=$2) AND ($3::boolean IS NULL OR active=$3)
      ORDER BY id DESC LIMIT $4`,[input.cursor ?? null,input.role ?? null,
      input.active===undefined?null:input.active==='true',input.limit+1]);
    const rows=result.rows.slice(0,input.limit);
    res.json({items:rows,nextCursor:result.rows.length>input.limit?rows.at(-1)?.id ?? null:null});
  });
  router.get('/users/:id',requireRole('MANAGER'),async(req,res) => {
    const userId=idInput.parse(req.params.id);
    const found=await pool.query(`SELECT id::text,email,display_name AS "displayName",role,active,
      must_change_password AS "mustChangePassword",locale,timezone,created_at AS "createdAt"
      FROM orderflow.users WHERE id=$1`,[userId]);
    if(!found.rowCount) throw new AppError(404,'NOT_FOUND','User not found.');
    const warehouses=await pool.query(`SELECT warehouse_id::text AS id FROM orderflow.user_warehouses
      WHERE user_id=$1 ORDER BY warehouse_id`,[userId]);
    res.json({...found.rows[0],warehouseIds:warehouses.rows.map(row=>row.id)});
  });
  router.post('/users/:id/reset-password',requireRole('MANAGER'),async(req,res) => {
    const userId=idInput.parse(req.params.id);
    const input=z.object({temporaryPassword:z.string().min(12).max(1024)}).strict().parse(req.body);
    const actor=res.locals.actor as Actor;
    const nextHash=await passwordHash(input.temporaryPassword);
    await withMutation(pool,req,actor,async c => {
      const found=await c.query('SELECT 1 FROM orderflow.users WHERE id=$1 FOR UPDATE',[userId]);
      if(!found.rowCount) throw new AppError(404,'NOT_FOUND','User not found.');
      await c.query('UPDATE orderflow.users SET password_hash=$1,must_change_password=true WHERE id=$2',
        [nextHash,userId]);
      await c.query('UPDATE orderflow.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
        [userId]);
      await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'PASSWORD_RESET','user',$2)`,[actor.id,userId]);
    });
    res.status(204).end();
  });
  router.patch('/users/:id', requireRole('MANAGER'), async (req, res) => {
    const id = idInput.parse(req.params.id);
    const input = userUpdate.parse(req.body);
    if (Object.keys(input).length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Provide a field to change.');
    const actor = res.locals.actor as Actor;
    await withMutation(pool,req,actor,async client => {
      const row = await client.query('SELECT id,display_name,role,active FROM orderflow.users WHERE id=$1 FOR UPDATE', [id]);
      if (!row.rowCount) throw new AppError(404, 'NOT_FOUND', 'User not found.');
      const current = row.rows[0];
      await client.query('UPDATE orderflow.users SET display_name=$1,role=$2,active=$3 WHERE id=$4',
        [input.displayName ?? current.display_name, input.role ?? current.role, input.active ?? current.active, id]);
      if (input.active === false) await client.query('UPDATE orderflow.sessions SET revoked_at=now() WHERE user_id=$1', [id]);
      await client.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id,details) VALUES($1,'USER_UPDATE','user',$2,$3)", [actor.id, id, JSON.stringify(input)]);
    });
    res.status(204).end();
  });
  router.put('/users/:id/warehouses', requireRole('MANAGER'), async (req, res) => {
    const id = idInput.parse(req.params.id);
    const input = z.object({ warehouseIds: z.array(idInput).max(200) }).strict().parse(req.body);
    const ids = [...new Set(input.warehouseIds)];
    const actor = res.locals.actor as Actor;
    await withMutation(pool,req,actor,async client => {
      const user = await client.query('SELECT id FROM orderflow.users WHERE id=$1 FOR UPDATE', [id]);
      if (!user.rowCount) throw new AppError(404, 'NOT_FOUND', 'User not found.');
      await client.query('DELETE FROM orderflow.user_warehouses WHERE user_id=$1', [id]);
      if (ids.length) await client.query('INSERT INTO orderflow.user_warehouses(user_id,warehouse_id) SELECT $1, unnest($2::bigint[])', [id, ids]);
      await client.query("INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id,details) VALUES($1,'WAREHOUSE_ASSIGN','user',$2,$3)", [actor.id, id, JSON.stringify({ warehouseIds: ids })]);
    });
    res.status(204).end();
  });
  return router;
}
